"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "support-agent.tenantId";

/** No auth/session in v0.1 — the "active tenant" is just whatever's in
 * localStorage, set via the picker on the home page. See lib/api.ts for the
 * matching caveat on the backend side. */
export function useTenant() {
  const [tenantId, setTenantIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTenantIdState(window.localStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  function setTenantId(id: string) {
    window.localStorage.setItem(STORAGE_KEY, id);
    setTenantIdState(id);
  }

  return { tenantId, setTenantId, ready };
}
