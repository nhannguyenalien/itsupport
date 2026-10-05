package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Pre-backup PostgreSQL dumps for databases running in Docker containers
// (Coolify and similar). Copying a live Postgres data directory gives a
// restore that may not start, so the backup job first writes a consistent
// logical dump into dumpDir(), which is then added to the restic paths.
//
// Everything here is fixed-shape: the docker binary is one of two known paths,
// the subcommand is `exec <container> pg_dump|pg_dumpall`, and container, user
// and database must match strict identifier patterns, so a policy can never turn
// into an arbitrary command.

const (
	maxDbDumps  = 20
	dumpTimeout = 30 * time.Minute
)

var (
	containerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	pgIdentPattern       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$-]{0,62}$`)
)

type dbDump struct {
	container string
	user      string
	database  string // empty = every database (pg_dumpall)
}

func (d dbDump) fileName() string {
	if d.database == "" {
		return d.container + "__ALL.sql"
	}
	return d.container + "__" + d.database + ".dump"
}

func dumpDir() string { return filepath.Join(backupDir(), "dumps") }

func parseDbDumps(raw any) ([]dbDump, error) {
	list, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("\"db_dumps\" must be an array")
	}
	if len(list) > maxDbDumps {
		return nil, fmt.Errorf("at most %d database dumps", maxDbDumps)
	}
	out := make([]dbDump, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("each db_dumps entry must be an object")
		}
		d := dbDump{user: "postgres"}
		d.container, _ = m["container"].(string)
		if u, _ := m["user"].(string); u != "" {
			d.user = u
		}
		d.database, _ = m["database"].(string)
		if !containerNamePattern.MatchString(d.container) {
			return nil, fmt.Errorf("invalid container name %q", d.container)
		}
		if !pgIdentPattern.MatchString(d.user) {
			return nil, fmt.Errorf("invalid database user %q", d.user)
		}
		if d.database != "" && !pgIdentPattern.MatchString(d.database) {
			return nil, fmt.Errorf("invalid database name %q", d.database)
		}
		out = append(out, d)
	}
	return out, nil
}

func dockerBinary() (string, error) {
	for _, p := range []string{"/usr/bin/docker", "/usr/local/bin/docker"} {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("docker not found (looked in /usr/bin and /usr/local/bin)")
}

// runDatabaseDumps replaces the contents of dumpDir() with fresh dumps and
// returns one message per dump that failed. Old dumps are removed first so a
// snapshot never carries a stale file that looks current.
func runDatabaseDumps(ctx context.Context, dumps []dbDump) []string {
	docker, err := dockerBinary()
	if err != nil {
		return []string{err.Error()}
	}
	dir := dumpDir()
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return []string{err.Error()}
	}
	var failures []string
	for _, d := range dumps {
		if err := dumpOne(ctx, docker, dir, d); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", d.container, err))
		}
	}
	return failures
}

func dumpOne(parent context.Context, docker, dir string, d dbDump) error {
	ctx, cancel := context.WithTimeout(parent, dumpTimeout)
	defer cancel()
	args := []string{"exec", d.container}
	if d.database == "" {
		args = append(args, "pg_dumpall", "-U", d.user)
	} else {
		args = append(args, "pg_dump", "-U", d.user, "-Fc", d.database)
	}
	dest := filepath.Join(dir, d.fileName())
	partial := dest + ".partial"
	f, err := os.OpenFile(partial, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd := exec.CommandContext(ctx, docker, args...)
	cmd.Stdout, cmd.Stderr = f, &stderr
	runErr := cmd.Run()
	closeErr := f.Close()
	if runErr != nil || closeErr != nil {
		_ = os.Remove(partial)
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if runErr != nil {
			return fmt.Errorf("%v: %s", runErr, msg)
		}
		return closeErr
	}
	return os.Rename(partial, dest)
}
