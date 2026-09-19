import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { companion } from './agents/companion';
import { storage } from './storage';

export const mastra = new Mastra({
  agents: { companion },
  storage,
  logger: new PinoLogger({ name: 'ivf-companion', level: 'info' }),
});
