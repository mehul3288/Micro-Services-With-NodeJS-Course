'use client';

import { useEffect, useState } from 'react';
import StripeCheckout from 'react-stripe-checkout';
import { useRouter } from 'next/navigation';
import useRequest from '../../../hooks/use-request';
import ErrorAlert from '../../../components/error-alert';

export default function OrderShow({ order, currentUser }) {
  const router = useRouter();
  const [timeLeft, setTimeLeft] = useState(0);

  const { doRequest, errors } = useRequest({
    url: '/api/payments',
    method: 'post',
    body: {
      orderId: order.id,
    },
    onSuccess: () => {
      router.push('/orders');
      router.refresh();
    },
  });

  useEffect(() => {
    const findTimeLeft = () => {
      const msLeft = new Date(order.expiresAt) - new Date();
      setTimeLeft(Math.round(msLeft / 1000));
    };

    findTimeLeft();
    const timerId = setInterval(findTimeLeft, 1000);

    return () => {
      clearInterval(timerId);
    };
  }, [order]);

  if (timeLeft < 0) {
    return <div>Order Expired</div>;
  }

  return (
    <div>
      <p>Time left to pay: {timeLeft} seconds</p>
      <StripeCheckout
        token={({ id }) => doRequest({ token: id })}
        stripeKey="pk_test_51UM27FDKOGNQYYhb3kzkLMpjXeWIrl6L1EF36xaiqu9Ltn9qziIR3umD9BzLry5lCydlkQ1G0RozLbt9w0YRUPwU00hgheosGn"
        amount={order.ticket.price * 100}
        email={currentUser?.email}
      />
      <ErrorAlert errors={errors} />
    </div>
  );
}
