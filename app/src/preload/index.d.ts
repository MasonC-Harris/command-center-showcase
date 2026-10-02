import { ElectronAPI } from '@electron-toolkit/preload'
import type { CommandCenterApi } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: CommandCenterApi
  }
}
