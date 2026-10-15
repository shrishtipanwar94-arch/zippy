// WHICH IP VERSION TO LOOK REDIS UP ON.
//
// ioredis resolves a hostname to IPv4 only unless told otherwise. Railway's
// private network names (`redis.railway.internal`) can resolve to IPv6 only,
// so a default ioredis client cannot find the Redis it is pointed at and
// retries forever. `0` means "either": the OS resolver decides, which is
// IPv4 for localhost in development and whatever the platform offers in
// production. One constant, used by all three places a client is created.
export const REDIS_ADDRESS_FAMILY = 0;
