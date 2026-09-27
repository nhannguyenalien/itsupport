"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export function useTenant() {
  const [tenantId, setTenantIdState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.me()
      .then(({ user }) => setTenantIdState(user.tenantId))
      .catch(() => setTenantIdState(null))
      .finally(() => setReady(true));
  }, []);

  return { tenantId, ready };
}
