import { Config, Env } from './types';

// @ts-ignore
let CONSTANTS: Config = {
  UUID_LENGTH: 4,
  enable_large_upload: false,
};
export default CONSTANTS;

// Fetch variable from Env
export const fetch_constant = (env: Env) => {
  if (env.LARGE_AWS_ACCESS_KEY_ID && env.LARGE_AWS_SECRET_ACCESS_KEY && env.LARGE_DOWNLOAD_ENDPOINT) {
    CONSTANTS.enable_large_upload = true;
  }
  CONSTANTS = {
    ...env,
    ...CONSTANTS,
  };
};
