import { EnvironCredentialsProvider } from '@ydbjs/auth/environ';
import type { YdbBinding } from './driver/index.js';

/** Share the official SDK's authentication and TLS configuration between CLI and app. */
export function ydbBindingFromEnv(
  url = process.env['YDB_CONNECTION_STRING'],
): YdbBinding {
  if (!url) throw new Error('Set YDB_CONNECTION_STRING');
  const credentialsProvider = new EnvironCredentialsProvider(url);
  return {
    url,
    driverOptions: {
      credentialsProvider,
      secureOptions: credentialsProvider.secureOptions,
    },
  };
}
