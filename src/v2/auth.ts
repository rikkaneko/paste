import { Env, ERequest } from '../types';
import Config from '../config';
import { PasteAPIRepsonse } from './schema';

/* 
 * V2 Check Token Scope
 */
export const v2_token_check_scope = async (required_scopes: string[], token: string): Promise<boolean> => {
  const config = Config.get().config();
  if (config.auth_v2_endpoint) {
    // Check Token Scope
    const res = await fetch(`${config.auth_v2_endpoint}/auth/verify/check-scope`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(required_scopes),
    });
    const check: { result: boolean } = await res.json();
    return check.result;
  }
  return false;
}

/* 
 * Auth middleware
 * 
 * Check against static auth token or V2 token
*/
export const do_auth_v2 =
  (method: 'static_token' | 'v2_token' | 'both', required_scopes: string[] = []) =>
  async (req: ERequest, env: Env, ctx: ExecutionContext) => {
    const { headers } = req;
    let token: string | undefined;
    // Retrieve from Authorization header
    const auth = headers.get('Authorization');
    if (!auth) {
      return PasteAPIRepsonse.build(403, 'Invalid token.');
    }
    const [scheme, encoded] = auth!.split(' ');
    // Validate authorization header format
    if (!encoded) {
      return PasteAPIRepsonse.build(403, 'Invalid token.');
    }
    // Only allow Bearer token
    if (scheme == 'Bearer') {
      if (encoded.length > 0) token = encoded;
      else return PasteAPIRepsonse.build(403, 'Invalid token.');
    } else {
      return PasteAPIRepsonse.build(403, 'Invalid token.');
    }

    // Save token to req object
    req.auth = {
      token: token,
    };

    // Static admin token
    if (method == 'static_token' || method == 'both') {
      const check = Config.check_auth(token);
      if (check) {
        return; // Pass
      } else if (method != 'both') {
        return PasteAPIRepsonse.build(403, 'Invalid token.');
      }
    }

    // V2 token
    const config = Config.get().config();
    // V2 auth token
    // Only appliable when config.auth_v2_endpoint is defined
    if (config.auth_v2_endpoint) {
      try {
        if (await v2_token_check_scope(required_scopes, token)) {
          return; // Pass
        } else {
          return PasteAPIRepsonse.build(403, 'Invalid token.');
        }
      } catch (e) {
        if (e instanceof Error) return PasteAPIRepsonse.build(500, `Unable to verify the supplied token: ${e.message}`);
      }
    }

    // Neither method pass
    return PasteAPIRepsonse.build(403, 'Invalid token.');
  };