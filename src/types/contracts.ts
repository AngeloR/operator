import { type MessageFormat } from "../text";

export type QueueDirection = "agent" | "user";

export type QueueEnvelope = {
  id: string;
  projectKey: string;
  roomId: string;
  body: string;
  format: MessageFormat;
  agent?: string;
  sender?: string;
  receivedAt: string;
};

export type QueueEnvelopeExtras = {
  agent?: string;
  sender?: string;
};

export type AgentPollRequestPayload = {
  project?: string;
  project_key?: string;
  agent?: string;
  block_seconds?: number | string;
};

export type AgentSendRequestPayload = {
  project?: string;
  project_key?: string;
  markdown?: string;
  body?: string;
  message?: string;
  text?: string;
  format?: string;
  agent?: string;
};
