import buildClient from '../../api/build-client';

export default async function OrderIndexPage() {
  let orders = [];
  try {
    const client = await buildClient();
    const { data } = await client.get('/api/orders');
    orders = data || [];
  } catch (err) {
    console.error(err);
  }

  return (
    <div>
      <h1>Orders</h1>
      <ul>
        {orders.map((order) => {
          return (
            <li key={order.id}>
              {order.ticket.title} - {order.status}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
