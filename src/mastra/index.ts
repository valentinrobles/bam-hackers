import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { companion } from './agents/companion';
import { callCredentialsRoute, callEndedRoute, callPageRoute } from './routes/call';
import { nurseCardRoute, nurseDecisionRoute, reminderRoute } from './routes/demo';
import { remindersWorkflow } from './workflows/reminders';
import { evalMessageRoute } from './routes/eval';
import { storage } from './storage';

export const mastra = new Mastra({
  agents: { companion },
  workflows: { reminders: remindersWorkflow },
  storage,
  logger: new PinoLogger({ name: 'ivf-companion', level: 'info' }),
  server: {
    apiRoutes: [evalMessageRoute, nurseDecisionRoute, nurseCardRoute, reminderRoute, callPageRoute, callCredentialsRoute, callEndedRoute],
  },
});
