import Link from 'next/link';
import buildClient from '../api/build-client';

export default async function LandingPage() {
  let tickets = [];
  try {
    const client = await buildClient();
    const { data } = await client.get('/api/tickets');
    tickets = data || [];
  } catch (err) {
    console.error(err);
  }

  const ticketList = tickets.map((ticket) => {
    return (
      <tr key={ticket.id}>
        <td>{ticket.title}</td>
        <td>{ticket.price}</td>
        <td>
          <Link href={`/tickets/${ticket.id}`}>
            View
          </Link>
        </td>
      </tr>
    );
  });

  return (
    <div>
      <h1>Tickets</h1>
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Price</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>{ticketList}</tbody>
      </table>
    </div>
  );
}
