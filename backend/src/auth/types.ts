import "fastify";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  role: "admin" | "technician" | "member";
  tenantName: string;
  /** Platform operator (PLATFORM_ADMIN_EMAILS): may use the database backup. */
  platformAdmin?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    firebaseUid: string | null;
    agentDeviceId: string | null;
    agentTenantId: string | null;
  }
}
