'use client';

import { useState } from 'react';
import Link from 'next/link';
import axios from 'axios';

export default function TicketList({ initialTickets = [], initialCursor = null }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`/api/tickets?limit=20&after=${cursor}`);
      const newTickets = Array.isArray(data) ? data : (data?.tickets || []);
      const nextCursor = data?.nextCursor || null;

      setTickets((prev) => [...prev, ...newTickets]);
      setCursor(nextCursor);
    } catch (err) {
      console.error('Failed to load more tickets:', err);
      setError('Could not load more tickets. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const ticketRows = tickets.map((ticket) => {
    return (
      <tr key={ticket.id}>
        <td>{ticket.title}</td>
        <td>${ticket.price}</td>
        <td>
          <Link href={`/tickets/${ticket.id}`} className="btn btn-sm btn-outline-primary">
            View
          </Link>
        </td>
      </tr>
    );
  });

  return (
    <div>
      <table className="table table-hover align-middle">
        <thead>
          <tr>
            <th>Title</th>
            <th>Price</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>{ticketRows}</tbody>
      </table>

      {error && <div className="alert alert-danger">{error}</div>}

      {cursor && (
        <div className="text-center my-3">
          <button
            onClick={loadMore}
            disabled={loading}
            className="btn btn-primary"
          >
            {loading ? 'Loading...' : 'Load More Tickets'}
          </button>
        </div>
      )}
    </div>
  );
}
