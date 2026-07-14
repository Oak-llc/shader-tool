import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { anonymous, username } from 'better-auth/plugins';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
export const mongo = client.db();

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(mongo, { client }),
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
