export const taskIdentifier = task => task.mantisbt ? 'MANTISBT' : task.asana ? 'ASANA' : task.source === 'thread' ? 'THREAD' : task.source === 'local' ? 'LOCAL' : 'ASANA';
