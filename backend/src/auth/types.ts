import "fastify";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  role: "admin" | "technician" | "member";
  tenantName: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    firebaseUid: string | null;
    agentDeviceId: string | null;
    agentTenantId: string | null;
  }
}
