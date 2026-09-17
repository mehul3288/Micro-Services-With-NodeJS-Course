import 'bootstrap/dist/css/bootstrap.css';
import buildClient from '../api/build-client';
import Header from '../components/header';

export default async function RootLayout({ children }) {
  let currentUser = null;
  try {
    const client = await buildClient();
    const { data } = await client.get('/api/users/currentuser');
    currentUser = data.currentUser;
  } catch (err) {}

  return (
    <html lang="en">
      <body>
        <div>
          <Header currentUser={currentUser} />
          {children}
        </div>
      </body>
    </html>
  );
}
