import { authConfig } from './auth.config';

export const expiresAt = (now: number): number => now + authConfig.sessionSeconds;
