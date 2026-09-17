/** standard.test.ts —— 标准门注册（W0 空壳）。
 *
 * 无 Remote 面： contractPairSuite 整段删除（不留空壳）。
 * 无浏览器半： uiTests: false 显式开脱——本包为纯服务端远端 ComfyUI 调用插件，不占 settings slot，无 CSS/面板可测。
 */
import { pluginStandardSuite } from "dsh-check";

pluginStandardSuite({ metaUrl: import.meta.url, uiTests: false });
