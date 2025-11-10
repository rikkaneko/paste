import { NonRetryableError } from "cloudflare:workflows";
import { Env } from "./types";
import { ConfigParams, ConfigParamsValidator, StorageConfigParams } from './v2/schema';

class Config {
  private static _config: ConfigParams;
  private static _env: Env | undefined;
  private static kv: KVNamespace;
  private static config_name: string;
  private _config: ConfigParams;

  private constructor(config: ConfigParams) {
    this._config = structuredClone(config);
  }

  static async from_kv(kv: KVNamespace, config_name: string = 'config', attach_env?: Env) {
    const val = await kv.get(config_name);
    if (!val) {
      throw new Error('Unable to load service config.');
    }
    const config: ConfigParams = JSON.parse(val);
    if (!ConfigParamsValidator.test(config)) {
      throw new SyntaxError('Invalid config.');
    }
    // Validate if default storage configuration is provided
    if (!config.storages.some((ent) => ent.name === 'default')) {
      throw new SyntaxError('Invalid config: Missing default storage configuation.');
    }
    Config._config = config;
    Config.kv = kv;
    Config.config_name = config_name;
  }

  static async update(config: ConfigParams, config_auth_token: string): Promise<boolean> {
    if (!Config.check_auth(config_auth_token)) {
      return false;
    }
    await Config.kv.put(Config.config_name, JSON.stringify(config));
    Config._config = structuredClone(config);
    return true;
  }

  static check_auth(config_auth_token: string): boolean {
    const auth_token = Config._config.config_auth_token;
    return auth_token?.length > 0 && config_auth_token === auth_token;
  }

  static get(): Config {
    if (!Config._config) {
      throw new ReferenceError('Service config is not loaded.');
    }
    return new Config({
      ...Config._config,
      config_auth_token: '***',
    });
  }

  static env(): Env {
    if (Config._env) return Config._env;
    else throw new ReferenceError('Env is not yet attached.');
  }

  config(): ConfigParams {
    return {
      ...Config._config,
      config_auth_token: '***',
    };
  }

  filter_storage(storage_name: string): StorageConfigParams | null {
    const filtered = this._config.storages.filter((ent) => ent.name === storage_name);
    if (filtered.length >= 1) return filtered[filtered.length - 1];
    else return null;
  }
}

export default Config;