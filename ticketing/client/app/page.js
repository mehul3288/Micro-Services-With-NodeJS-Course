import buildClient from '../api/build-client';

export default async function LandingPage() {
  let currentUser = null;
  try {
    const client = await buildClient();
    const { data } = await client.get('/api/users/currentuser');
    currentUser = data.currentUser;
  } catch (err) {}

  return currentUser ? (
    <h1>You are signed in</h1>
  ) : (
    <h1>You are NOT signed in</h1>
  );
}
