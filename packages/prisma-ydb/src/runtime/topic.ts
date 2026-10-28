import { topic, type TopicClient } from '@ydbjs/topic';
import type { YdbDriver } from '../driver/driver.js';

/** Topic helpers sharing the connected YDB client's existing gRPC driver. */
export function topicClient(driver: YdbDriver): TopicClient {
  return topic(driver.core);
}
