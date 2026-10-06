import buildClient from '../../../api/build-client';
import OrderShow from './order-show';

export default async function OrderShowPage({ params }) {
  const { orderId } = await params;
  let order = null;
  let currentUser = null;
  try {
    const client = await buildClient();
    const [orderRes, userRes] = await Promise.all([
      client.get(`/api/orders/${orderId}`),
      client.get('/api/users/currentuser'),
    ]);
    order = orderRes.data;
    currentUser = userRes.data?.currentUser;
  } catch (err) {
    console.error(err);
  }

  if (!order) {
    return <div>Order not found</div>;
  }

  return <OrderShow order={order} currentUser={currentUser} />;
}
