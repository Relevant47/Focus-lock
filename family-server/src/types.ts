export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
}

export interface AuthContext {
  accountId: string;
}

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  email_verified_at: string | null;
}
