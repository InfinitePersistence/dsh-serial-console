/** Host-side Typert manifest discovered from the package's ./typert export. */
import { SERIAL_REMOTE_DESCRIPTORS } from './remote.js'

export const TYPERT = {
  package: '@infinitepersistence/dsh-serial-console',
  face: 'host',
  schemas: [],
  invocations: SERIAL_REMOTE_DESCRIPTORS,
  model: {
    services: [{
      description: 'Host-owned auditable serial console service.',
      summary: 'Host-owned serial console.',
      tags: [],
      key: 'serialConsole',
      exportName: 'SerialConsoleService',
      members: [],
      types: [],
    }],
    events: [],
    objects: [],
  },
}
