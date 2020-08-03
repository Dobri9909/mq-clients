import { AssertionError } from 'assert';
import { DeepPartial } from 'ts-essentials';
import { merge } from 'lodash';

import {
  mockAmqplib,
  mockChannel,
  mockConnection,

  createMockQueue,
  triggerMockConnectionListener,
  triggerMockChannelConsumer,
  resetMocks,
  simulateShutdown,
} from './mocks';

import {
  RabbitMQClient,
  RabbitMQConstructorParams,
  MQConnectionError,
} from '../src/index';

function createConstructorParams(overrides: DeepPartial<RabbitMQConstructorParams> = {}): RabbitMQConstructorParams {
  const defaultConstructorParams: RabbitMQConstructorParams = {
    retryTimeout: 100,
    exchange: {
      type: 'fanout',
    },
    amqp: {
      protocol: 'p',
      hostname: 'h',
      port: 1,
      username: 'u',
      password: 'p',
      locale: 'l',
      frameMax: 1,
      heartbeat: 1,
      vhost: '',
    },
  };

  return merge(defaultConstructorParams, overrides);
}

const sleep = (msec: number) => new Promise((resolve) => setTimeout(resolve, msec));

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => { };

describe('RabbitMQClient', () => {
  let client: RabbitMQClient;
  const constructorParams = createConstructorParams();
  beforeEach(() => {
    resetMocks();
    client = new RabbitMQClient(constructorParams);
  });

  describe('Fanout specs', () => {
    const defaultConstructorParams = createConstructorParams();
    const testRetryTimeout = defaultConstructorParams.retryTimeout + 200;

    it('should throw AssertionError when constructing with with direct exchange and not supplying the name of the exchange', async () => {
      expect(() => new RabbitMQClient(createConstructorParams({
        exchange: {
          type: 'direct',
        },
      }))).toThrow(AssertionError);
    });

    it('should throw AssertionError when constructing with with direct exchange and supplying empty exchange', async () => {
      expect(() => new RabbitMQClient(createConstructorParams({
        exchange: {
          type: 'direct',
          name: '',
        },
      }))).toThrow(AssertionError);
    });

    it('should call the amqplib.connect method with the correct opts from the constructor', async () => {
      const params = createConstructorParams();
      const customClient = new RabbitMQClient(params);
      await customClient.connect();

      expect(mockAmqplib.connect).toHaveBeenCalledWith(params.amqp);
    });

    it('should throw MQConnectionError when amqplib.connect throws', async () => {
      mockAmqplib.connect.mockRejectedValueOnce(new Error('Failed to connect!'));

      await expect(client.connect()).rejects.toThrow(MQConnectionError);
    });

    it('should throw MQConnectionError when connection.createChannel throws', async () => {
      mockConnection.createChannel.mockRejectedValueOnce(new Error('Failed to create channel!'));

      await expect(client.connect()).rejects.toThrow(MQConnectionError);
    });

    it('should throw AssertionError when calling it without connecting first', async () => {
      expect(() => client.publish('namespace', 1)).toThrow(AssertionError);
    });

    it('should create a durable fanout exchange when calling with a name equal to the namespace', async () => {
      await client.connect();
      client.publish('my-namespace', 1);
      await sleep(testRetryTimeout);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('my-namespace', 'fanout', { durable: true });
    });

    const durableTestCases = [
      [undefined, true],
      [true, true],
      [false, false],
    ];
    for (const [passedValue, expectedValue] of durableTestCases) {
      it(`should create an exchange with durable = ${expectedValue} when passing ${passedValue} `, async () => {
        const customClient = new RabbitMQClient(createConstructorParams({
          exchange: {
            durable: passedValue,
          },
        }));

        await customClient.connect();
        customClient.publish('my-namespace', 1);
        await sleep(testRetryTimeout);

        expect(mockChannel.assertExchange).toHaveBeenCalledWith('my-namespace', 'fanout', expect.objectContaining({ durable: expectedValue }));
      });
    }

    it('should publish a message with empty routingKey in the newly created exchange', async () => {
      await client.connect();
      client.publish('my-namespace', 1);
      await sleep(100);

      expect(mockChannel.publish).toHaveBeenCalledWith('my-namespace', '', expect.anything());
    });

    it('should publish the message as a buffer with payload of the json serialized message', async () => {
      await client.connect();

      const dummyPayload = { bar: 'foo' };
      client.publish('my-namespace', dummyPayload);
      await sleep(testRetryTimeout);

      expect(mockChannel.publish).toHaveBeenCalledWith(expect.anything(), expect.anything(), Buffer.from(JSON.stringify(dummyPayload)));
    });

    it('should retry to send the message when the connection is down', async () => {
      await client.connect();

      mockConnection.createChannel.mockRejectedValueOnce(new Error('Failed to create channel!'));
      triggerMockConnectionListener('error', new Error('Something went wrong'));

      const dummyPayload = { bar: 'foo' };
      client.publish('my-namespace', dummyPayload);
      await sleep(testRetryTimeout);

      expect(mockChannel.publish).toHaveBeenCalledWith(expect.anything(), expect.anything(), Buffer.from(JSON.stringify(dummyPayload)));
    });

    it('should return undefined', async () => {
      await client.connect();

      expect(client.publish('my-namespace', 1)).toBeUndefined();
    });

    it('should automatically attempt to reconnect in case the connection is dropped', async () => {
      await client.connect();

      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      expect(mockAmqplib.connect).toHaveBeenCalledTimes(2);
      expect(mockConnection.createChannel).toHaveBeenCalledTimes(2);
    });

    it('should throw AssertionError when calling subscribe before connecting', async () => {
      await expect(client.subscribe('namespace', noop)).rejects.toThrow(AssertionError);
    });

    it('should create a durable fanout exchange for the particular namespace when calling subscribe', async () => {
      await client.connect();
      await client.subscribe('my-namespace', noop);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('my-namespace', 'fanout', { durable: true });
    });

    it('should create an anonymous queue when calling subscribe (and no queue config was passed)', async () => {
      await client.connect();
      await client.subscribe('my-namespace', noop);

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('', { exclusive: true });
    });

    it('should create a custom queue when the calling subscribe (and queue config was passed)', async () => {
      const queueConfiguredClient = new RabbitMQClient(createConstructorParams({
        queue: {
          name: 'my-queue',
          exclusive: false,
        },
      }));
      await queueConfiguredClient.connect();
      await queueConfiguredClient.subscribe('my-namespace', noop);

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('my-queue', { exclusive: false });
    });

    it('should bind the anonymous queue to the exchange using empty routingKey when calling subscribe', async () => {
      const mockQueue = createMockQueue();
      mockChannel.assertQueue.mockResolvedValueOnce(mockQueue);

      await client.connect();
      await client.subscribe('my-namespace', noop);

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(mockQueue.queue, 'my-namespace', '');
    });

    it('should consume the anonymous queue when calling subscribe', async () => {
      const mockQueue = createMockQueue();
      mockChannel.assertQueue.mockResolvedValueOnce(mockQueue);

      await client.connect();
      await client.subscribe('my-namespace', noop);

      expect(mockChannel.consume).toHaveBeenCalledWith(mockQueue.queue, expect.anything(), { noAck: true });
    });

    it('should invoke the callback passed to subscribe when a message is received', async () => {
      const directModeConfiguredClient = new RabbitMQClient(createConstructorParams({
        exchange: {
          type: 'direct',
          name: 'my-exchange',
        },
      }));
      const mockQueue = createMockQueue();
      mockChannel.assertQueue.mockResolvedValueOnce(mockQueue);

      await directModeConfiguredClient.connect();

      const mockCallback = jest.fn();
      const dummyData = { bar: 'foo' };
      await directModeConfiguredClient.subscribe('my-namespace', mockCallback);

      triggerMockChannelConsumer('my-exchange', mockQueue.queue, dummyData);
      await sleep(testRetryTimeout);

      expect(mockCallback).toHaveBeenCalledWith(dummyData);
    });

    it('should not kill the process when the message fails to be parsed', async () => {
      const mockQueue = createMockQueue();
      mockChannel.assertQueue.mockResolvedValueOnce(mockQueue);

      await client.connect();

      const mockCallback = jest.fn();
      await client.subscribe('my-namespace', mockCallback);

      const dummyData = 'not-a-valid-json';
      triggerMockChannelConsumer('my-namespace', mockQueue.queue, dummyData, false);
      await sleep(testRetryTimeout);
    });

    it('should recreate the previously created queues on reconnect', async () => {
      await client.connect();
      await client.subscribe('my-namespace', noop);
      await client.subscribe('my-namespace', noop);

      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      expect(mockChannel.assertQueue).toHaveBeenCalledTimes(3);
      expect(mockChannel.assertQueue).toHaveBeenNthCalledWith(3, '', { exclusive: true });
    });

    it('should bind the newly created queues to the exchange', async () => {
      await client.connect();
      await client.subscribe('my-namespace', noop);

      const mockQueue = createMockQueue('queue-2.0');
      mockChannel.assertQueue.mockResolvedValue(mockQueue);
      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      expect(mockChannel.bindQueue).toHaveBeenCalledTimes(2);
      expect(mockChannel.bindQueue).toHaveBeenNthCalledWith(2, mockQueue.queue, 'my-namespace', '');
    });

    it('should consume the newly recreated queues', async () => {
      await client.connect();

      const mockCallback = jest.fn();
      await client.subscribe('my-namespace', mockCallback);

      const mockQueue = createMockQueue('queue-2.0');
      mockChannel.assertQueue.mockResolvedValue(mockQueue);

      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      expect(mockChannel.consume).toHaveBeenCalledTimes(2);
      expect(mockChannel.consume).toHaveBeenNthCalledWith(2, mockQueue.queue, expect.anything(), { noAck: true });
    });

    it('should invoke the callback passed to subscribe when a message is received after a reconnect', async () => {
      await client.connect();

      const mockCallback = jest.fn();
      await client.subscribe('my-namespace', mockCallback);

      const mockQueue = createMockQueue('queue-2.0');
      mockChannel.assertQueue.mockResolvedValue(mockQueue);

      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      const dummyData = {};
      triggerMockChannelConsumer('my-namespace', mockQueue.queue, dummyData);
      await sleep(testRetryTimeout);

      expect(mockCallback).toHaveBeenCalledWith(dummyData);
    });

    it('should not invoke the callback passed to subscribe when a malformed message is received after a reconnect', async () => {
      await client.connect();

      const mockCallback = jest.fn();
      await client.subscribe('my-namespace', mockCallback);

      const mockQueue = createMockQueue('queue-2.0');
      mockChannel.assertQueue.mockResolvedValue(mockQueue);

      triggerMockConnectionListener('error', new Error('Something went wrong'));
      await sleep(testRetryTimeout);

      const dummyData = 'not-a-valid-json';
      triggerMockChannelConsumer('my-namespace', mockQueue.queue, dummyData, false);
      await sleep(testRetryTimeout);

      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('Direct specs', () => {
    const defaultConstructorParams: RabbitMQConstructorParams = {
      retryTimeout: 100,
      exchange: {
        type: 'direct',
        name: 'direct-exchange',
      },
    };

    const testRetryTimeout = defaultConstructorParams.retryTimeout + 200;

    beforeEach(() => {
      client = new RabbitMQClient(defaultConstructorParams);
    });

    it('should create a durable direct exchange with the name provided inside the construction params', async () => {
      await client.connect();
      await client.publish('my-nsp', 'whatever');
      await sleep(testRetryTimeout);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('direct-exchange', 'direct', { durable: true });
    });

    it('should publish a message with the namespace as routingKey in the newly created direct exchange', async () => {
      await client.connect();
      client.publish('my-namespace', 1);
      await sleep(100);

      expect(mockChannel.publish).toHaveBeenCalledWith('direct-exchange', 'my-namespace', expect.anything());
    });

    it('should bind the anonymous queue to the direct exchange using the namespace as routingKey when calling subscribe', async () => {
      const mockQueue = createMockQueue();
      mockChannel.assertQueue.mockResolvedValueOnce(mockQueue);

      await client.connect();
      await client.subscribe('my-namespace', noop);

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(mockQueue.queue, 'direct-exchange', 'my-namespace');
    });
  });

  describe('Reconnection', () => {
    it('should attempt to recreate the connection once it was closed', async () => {
      await client.connect();
      mockAmqplib.connect.mockClear();
      mockConnection.createChannel.mockClear();

      simulateShutdown();
      await sleep(100);

      expect(mockAmqplib.connect).toHaveBeenCalledWith(constructorParams.amqp);
      expect(mockConnection.createChannel).toHaveBeenCalled();
    });

    it('should recreate the existing queues as they were before the connection was closed', async () => {
      await client.connect();
      await client.subscribe('nsp1', noop);
      await client.subscribe('nsp2', noop);
      await client.subscribe('nsp3', noop);
      mockChannel.bindQueue.mockClear();

      simulateShutdown();
      await sleep(100);

      expect(mockChannel.bindQueue).toHaveBeenNthCalledWith(1, expect.anything(), 'nsp1', expect.anything());
      expect(mockChannel.bindQueue).toHaveBeenNthCalledWith(2, expect.anything(), 'nsp2', expect.anything());
      expect(mockChannel.bindQueue).toHaveBeenNthCalledWith(3, expect.anything(), 'nsp3', expect.anything());
    });
  });
});
