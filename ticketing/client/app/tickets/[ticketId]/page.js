import buildClient from '../../../api/build-client';
import TicketShow from './ticket-show';

export default async function TicketShowPage({ params }) {
  const { ticketId } = await params;
  let ticket = null;
  try {
    const client = await buildClient();
    const { data } = await client.get(`/api/tickets/${ticketId}`);
    ticket = data;
  } catch (err) {
    console.error(err);
  }

  if (!ticket) {
    return <div>Ticket not found</div>;
  }

  return <TicketShow ticket={ticket} />;
}
