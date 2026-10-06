// Publishes ticket events to a Redis stream consumed by notification-service.
// Publishing is best effort: if Redis is down, ticket writes still succeed and the failure is counted and logged.
export function createPublisher({ redis, streamKey, logger, metrics }) {
  return {
    async publish(type, data) {
      try {
        await redis.xadd(streamKey, 'MAXLEN', '~', '10000', '*', 'type', type, 'payload', JSON.stringify(data));
        metrics.eventsPublished.inc({ type });
        return true;
      } catch (err) {
        metrics.eventsFailed.inc({ type });
        logger.error({ err: err.message, type }, 'failed to publish event');
        return false;
      }
    },
    async ping() {
      return (await redis.ping()) === 'PONG';
    },
  };
}
