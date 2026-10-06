'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useRequest from '../../../hooks/use-request';
import ErrorAlert from '../../../components/error-alert';

export default function NewTicketPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');

  const { doRequest, errors } = useRequest({
    url: '/api/tickets',
    method: 'post',
    body: {
      title,
      price,
    },
    onSuccess: () => {
      router.push('/');
      router.refresh();
    },
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    await doRequest();
  };

  const onBlur = () => {
    const value = parseFloat(price);

    if (isNaN(value)) {
      return;
    }

    setPrice(value.toFixed(2));
  };

  return (
    <div>
      <h1>Create a Ticket</h1>
      <form onSubmit={onSubmit}>
        <div className="form-group mb-3">
          <label>Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="form-control"
            placeholder="Title"
          />
        </div>
        <div className="form-group mb-3">
          <label>Price</label>
          <input
            value={price}
            onBlur={onBlur}
            onChange={(e) => setPrice(e.target.value)}
            className="form-control"
            placeholder="0.00"
          />
        </div>
        <ErrorAlert errors={errors} />
        <button className="btn btn-primary">Submit</button>
      </form>
    </div>
  );
}
