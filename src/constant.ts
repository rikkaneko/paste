import { Config, Env } from './types';

// @ts-ignore
let CONSTANTS: Config = {
  UUID_LENGTH: 4,
};
export default CONSTANTS;

// Fetch variable from Env
export const fetch_constant = (env: Env) => {
  CONSTANTS = {
    ...env,
    ...CONSTANTS,
  };
};
