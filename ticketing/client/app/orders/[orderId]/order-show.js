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

  if (order.status === 'complete') {
    return (
      <div className="alert alert-success">
        <h4>Order Complete</h4>
        <p>Your payment was successful and your ticket has been reserved!</p>
      </div>
    );
  }

  if (order.status === 'cancelled') {
    return (
      <div className="alert alert-danger">
        <h4>Order Cancelled</h4>
        <p>Your order expired before payment completed. You have been refunded.</p>
      </div>
    );
  }

  if (timeLeft <= 0) {
    return (
      <div className="alert alert-warning">
        <h4>Order Expired</h4>
        <p>This order has expired. Please return to tickets and place a new order.</p>
      </div>
    );
  }

  return (
    <div>
      <h3>Purchasing {order.ticket.title}</h3>
      <h4>Price: ${order.ticket.price}</h4>
      <p>Time left to pay: {timeLeft} seconds</p>

      {timeLeft < 5 ? (
        <div className="alert alert-warning">
          Order is about to expire ({timeLeft}s left). Payment is blocked to prevent duplicate billing.
        </div>
      ) : (
        <StripeCheckout
          token={({ id }) => doRequest({ token: id })}
          stripeKey="pk_test_51UM27FDKOGNQYYhb3kzkLMpjXeWIrl6L1EF36xaiqu9Ltn9qziIR3umD9BzLry5lCydlkQ1G0RozLbt9w0YRUPwU00hgheosGn"
          amount={order.ticket.price * 100}
          email={currentUser?.email}
        />
      )}
      <ErrorAlert errors={errors} />
    </div>
  );
}
