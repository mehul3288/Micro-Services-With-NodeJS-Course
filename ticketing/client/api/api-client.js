import axios from 'axios';

let refreshPromise = null;

/**
 * Execute silent token refresh. If multiple requests fail simultaneously with 401,
 * they share the same in-flight refresh promise to prevent token race conditions.
 */
export const silentRefresh = async () => {
  if (!refreshPromise) {
    refreshPromise = axios
      .post('/api/users/refresh', {})
      .then((res) => res.data)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
};

// Setup browser-side Axios interceptor for automatic 401 retry
if (typeof window !== 'undefined') {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      if (
        error.response?.status === 401 &&
        originalRequest &&
        !originalRequest._retry &&
        !originalRequest.url?.includes('/api/users/refresh') &&
        !originalRequest.url?.includes('/api/users/signin') &&
        !originalRequest.url?.includes('/api/users/signup')
      ) {
        originalRequest._retry = true;
        try {
          await silentRefresh();
          return axios(originalRequest);
        } catch (refreshErr) {
          // If refresh fails (token expired or family revoked), propagate rejection
          return Promise.reject(refreshErr);
        }
      }

      return Promise.reject(error);
    }
  );
}

export default axios;
