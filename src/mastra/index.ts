import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { companion } from './agents/companion';
import { nurseCardRoute, nurseDecisionRoute } from './routes/demo';
import { evalMessageRoute } from './routes/eval';
import { storage } from './storage';

export const mastra = new Mastra({
  agents: { companion },
  storage,
  logger: new PinoLogger({ name: 'ivf-companion', level: 'info' }),
  server: {
    apiRoutes: [evalMessageRoute, nurseDecisionRoute, nurseCardRoute],
  },
});
