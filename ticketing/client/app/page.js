import buildClient from '../api/build-client';
import TicketList from '../components/ticket-list';

export default async function LandingPage() {
  let initialTickets = [];
  let initialCursor = null;

  try {
    const client = await buildClient();
    const { data } = await client.get('/api/tickets?limit=20');

    if (Array.isArray(data)) {
      initialTickets = data;
    } else if (data && data.tickets) {
      initialTickets = data.tickets;
      initialCursor = data.nextCursor || null;
    }
  } catch (err) {
    console.error('Error fetching tickets for landing page:', err);
  }

  return (
    <div className="container mt-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2>Available Tickets</h2>
      </div>

      <TicketList
        initialTickets={initialTickets}
        initialCursor={initialCursor}
      />
    </div>
  );
}
