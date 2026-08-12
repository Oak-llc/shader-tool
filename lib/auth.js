import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { anonymous, username } from 'better-auth/plugins';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

export class PersistenceUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PersistenceUnavailableError';
    this.statusCode = 503;
  }
}

let client = null;
let mongo = null;
let auth = null;
let connectPromise = null;

function missingPersistenceVars() {
  return ['MONGODB_URI', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL']
    .filter((name) => !process.env[name]);
}

function assertPersistenceConfig() {
  const missing = missingPersistenceVars();
  if (missing.length) {
    throw new PersistenceUnavailableError(
      `Profile persistence is unavailable. Missing ${missing.join(', ')}.`
    );
  }
}

export function isPersistenceAvailable() {
  return missingPersistenceVars().length === 0;
}

export async function getMongo() {
  assertPersistenceConfig();
  if (mongo) return mongo;

  if (!connectPromise) {
    client = new MongoClient(process.env.MONGODB_URI);
    connectPromise = client.connect()
      .then(() => {
        mongo = client.db();
        return mongo;
      })
      .catch((err) => {
        client?.close().catch(() => {});
        client = null;
        mongo = null;
        connectPromise = null;
        throw new PersistenceUnavailableError('Profile persistence is unavailable.', { cause: err });
      });
  }

  return connectPromise;
}

export async function getAuth() {
  if (auth) return auth;

  const db = await getMongo();
  auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(db, { client }),
    session: {
      // Anonymous accounts should feel persistent across visits, not expire like a normal login.
      expiresIn: 60 * 60 * 24 * 365,
    },
    plugins: [
      anonymous({
        emailDomainName: 'anon.shadertool.local',
      }),
      username({
        minUsernameLength: 3,
        maxUsernameLength: 24,
      }),
    ],
  });

  return auth;
}
