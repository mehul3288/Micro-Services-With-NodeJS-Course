'use client';

import { useRouter } from 'next/navigation';
import useRequest from '../../../hooks/use-request';
import ErrorAlert from '../../../components/error-alert';

export default function TicketShow({ ticket }) {
  const router = useRouter();
  const { doRequest, errors } = useRequest({
    url: '/api/orders',
    method: 'post',
    body: {
      ticketId: ticket.id,
    },
    onSuccess: (order) => {
      router.push(`/orders/${order.id}`);
      router.refresh();
    },
  });

  return (
    <div>
      <h1>{ticket.title}</h1>
      <h4>Price: {ticket.price}</h4>
      <ErrorAlert errors={errors} />
      <button onClick={() => doRequest()} className="btn btn-primary">
        Purchase
      </button>
    </div>
  );
}
