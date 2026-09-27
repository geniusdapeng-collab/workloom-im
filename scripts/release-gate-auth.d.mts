export interface ReleaseGateLoginOptions {
  base: string;
  workspaceSlug: string;
  memberNo: string;
  email?: string;
  password?: string;
  nodeEnv?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}

export function releaseGateLogin(options: ReleaseGateLoginOptions): Promise<string>;
