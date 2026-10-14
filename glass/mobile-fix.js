/* 移动端侧栏：点击任意链接后自动关闭
 *
 * 背景：主题 main.js 只在两处调用 sidebarFn.close()
 *   - 点击 #menu-mask（第 950 行）
 *   - 窗口变宽、#toggle-menu 隐藏时（第 943 行）
 * 没有"点击侧栏里的链接后关闭"这一条。
 * 而本站开了 pjax，换页只替换内容区，#sidebar（在 pjax 容器之外）不会被重置，
 * 于是侧栏会一直挂在页面上。
 *
 * 监听范围必须是整个 #sidebar-menus，不能只绑 .menus_items ——
 * 侧栏里还有 .site-data（文章 / 标签 / 分类 三个链接），
 * 它们不在 .menus_items 内，只绑后者会漏掉。
 *
 * 做法：触发 #menu-mask 的 click ——
 * 直接复用主题自己的关闭逻辑（含遮罩淡出动画），
 * 既不修改主题文件，也不必改动作者的 glass.js。
 */
(function () {
  'use strict';

  var BOUND = 'sidebarAutoCloseBound';

  function closeSidebar() {
    var mask = document.getElementById('menu-mask');
    if (mask) {
      /* 复用主题绑定在遮罩上的关闭逻辑 */
      mask.click();
      return;
    }
    var sm = document.getElementById('sidebar-menus');
    if (sm) sm.classList.remove('open');
  }

  function bindSidebarAutoClose() {
    var sm = document.getElementById('sidebar-menus');
    if (!sm || sm.dataset[BOUND] === '1') return;

    /* 绑在容器上做事件委托，覆盖 .site-data 与 .menus_items 里的全部链接 */
    sm.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a') : null;
      if (!a || !sm.contains(a)) return;
      closeSidebar();
    });

    sm.dataset[BOUND] = '1';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindSidebarAutoClose);
  } else {
    bindSidebarAutoClose();
  }

  /* pjax 换页后兜底重新确认绑定（#sidebar 通常不被替换） */
  ['pjax:complete', 'pjax:success'].forEach(function (evt) {
    document.addEventListener(evt, bindSidebarAutoClose);
  });
})();
