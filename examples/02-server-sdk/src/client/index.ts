import { readConfig } from '../app/config'
import { runRemoteTask } from './run'

const config = readConfig()
runRemoteTask(config.serverUrl, config.key).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
