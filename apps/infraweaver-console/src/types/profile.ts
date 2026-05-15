export interface ProfileSummary {
  name: string;
  email: string;
  groups: string[];
}

export interface AuthentikSession {
  identifier: string;
  created: string;
  expires?: string;
  description?: string;
}

export interface LoginEvent {
  pk: string;
  created: string;
  action: string;
  context?: { result?: string };
}

export interface ProfileSessionsResponse {
  sessions: AuthentikSession[];
}

export interface ProfileActivityResponse {
  events: LoginEvent[];
}
