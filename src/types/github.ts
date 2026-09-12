export interface GithubUserInfo {
  username: string;
  email?: string;
}

export interface CopilotToken {
  token: string;
  expires_at: number;
  refresh_in: number;
  chat_enabled: boolean;
  sku: string;
  telemetry: string;
  tracking_id: string;
  /** Account-specific API hosts; individual/business/enterprise plans differ. */
  endpoints?: {
    api?: string;
    proxy?: string;
    telemetry?: string;
  };
}

export interface VerificationResponse {
  verification_uri: string;
  user_code: string;
  expires_in: number;
  interval: number;
  status: 'pending_verification' | 'authenticated';
}

export interface AuthenticationStatus {
  status: 'authenticated' | 'unauthenticated' | 'pending_verification' | 'error';
  expiresAt?: number;
  error?: string;
}
