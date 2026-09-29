-- Additive and idempotent; backend startup applies these changes as well.
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE computer_use_sessions ADD COLUMN IF NOT EXISTS action_count INT NOT NULL DEFAULT 0;
ALTER TABLE computer_use_sessions ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false;
