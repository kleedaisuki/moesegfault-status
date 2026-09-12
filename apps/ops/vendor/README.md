# MoeSegfault Style integration / 样式集成

Use the upstream **v0.1.2** static distribution from
[moesegfault-style](https://github.com/kleedaisuki/moesegfault-style).
The exact commit, paths and upstream SHA-256 values are recorded in
`moesegfault-style/v0.1.2/provenance.json`. Files are copied without modifications;
do not format or edit the release files. The upstream GPL-3.0-or-later license is
retained alongside them.

使用上游 **v0.1.2** 正式静态分发，固定提交、文件路径与 SHA-256 记录于同目录
`provenance.json`。原文件保持逐字节一致，不格式化、不手工修改；保留上游许可证。

The native TypeScript UI consumes the official token, foundation, component,
icon and motion layers. Application CSS only adapts operational layouts and uses
upstream semantic tokens. This follows the upstream plain-HTML integration path
without installing unused React/editor runtimes or contacting a third-party CDN
from the login page. Upgrade by importing and verifying a new version directory,
then updating the explicit imports and reviewing both themes.

The official component stylesheet also references KaTeX fonts. Those exact
versioned files and their separate license are included to keep every CSS URL
resolvable; they are not a new application editor or JavaScript dependency.

原生 TypeScript 界面使用官方设计令牌、基础样式、组件、图标与动画层；应用 CSS
只适配运维布局并引用语义令牌。遵循上游纯 HTML 接入方式，不引入无用的 React／编辑器
运行时，登录页也不请求第三方 CDN。升级时导入并校验新版本目录，更新显式导入并复核明暗主题。

官方组件样式还引用 KaTeX 字体，因此同时保留相同版本的字体与独立许可证，避免 CSS
存在悬空地址；这不代表应用增加编辑器或额外 JavaScript 运行时。
