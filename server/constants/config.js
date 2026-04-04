/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Disable web self-registration
 * Locks the instance so new accounts cannot be created through /api/auth/register.
 */
export const AUTH_DISABLE_REGISTRATION = process.env.AUTH_DISABLE_REGISTRATION === 'true';
