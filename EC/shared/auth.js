export const USERNAME_PATTERN = "[A-Za-z0-9_.@\\-\\u3400-\\u4dbf\\u4e00-\\u9fff]{3,64}";
export const PASSWORD_PATTERN = "(?=.*[A-Za-z]).{8,128}";
export const PASSWORD_HINT = "8–128 个字符，至少包含一个英文字母";

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };
const BLOCKED_USERNAMES = [
  "xijinping", "jinping", "xjp", "xidada", "baozi", "steambun", "winnie", "winniethepooh", "pooh", "xitler", "emperorxi",
  "liqiang", "likeqiang", "lkq", "zhaoleji", "wanghuning", "caiqi", "dingxuexiang", "hanzheng", "wangyi", "qingang",
  "hujintao", "hjt", "jiangzemin", "jzm", "wenjiabao", "wjb", "zhurongji", "zrj",
  "dengxiaoping", "dxp", "maozedong", "zedong", "mzd", "chairmanmao",
  "huyaobang", "hyb", "zhaoziyang", "zzy", "lipeng", "huaguofeng",
  "dalailama", "dalai", "tiananmen", "tankman", "8964", "liusi", "june4", "falungong", "falun",
  "习近平", "習近平", "习大大", "習大大", "习包子", "習包子", "维尼", "維尼", "维尼熊", "維尼熊", "小熊维尼", "小熊維尼",
  "李强", "李強", "李克强", "李克強", "赵乐际", "趙樂際", "王沪宁", "王滬寧", "蔡奇", "丁薛祥", "李希", "韩正", "韓正", "王毅", "秦刚", "秦剛",
  "胡锦涛", "胡錦濤", "江泽民", "江澤民", "温家宝", "溫家寶", "朱镕基", "朱鎔基", "邓小平", "鄧小平", "毛泽东", "毛澤東", "毛主席",
  "胡耀邦", "赵紫阳", "趙紫陽", "李鹏", "李鵬", "华国锋", "華國鋒",
  "达赖", "達賴", "达赖喇嘛", "達賴喇嘛", "天安门", "天安門", "六四", "八九六四", "坦克人", "法轮功", "法輪功", "法轮大法", "法輪大法",
];

export function usernameError(value) {
  if (typeof value !== "string" || !new RegExp(`^${USERNAME_PATTERN}$`).test(value.trim()))
    return "用户名需要 3–64 个字符：中文、英文字母、数字或 _ . @ -";
  const normalized = value.trim().toLowerCase().replace(/[._@-]/g, "");
  const leet = normalized.replace(/[013457]/g, c => LEET[c]);
  return BLOCKED_USERNAMES.some(term => normalized.includes(term) || leet.includes(term))
    ? "用户名含有不允许使用的词汇" : "";
}
export function passwordError(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && /[A-Za-z]/.test(value)
    ? "" : `密码需要 ${PASSWORD_HINT}`;
}
export function registrationError(username, password, confirmation) {
  return usernameError(username) || passwordError(password) || (password !== confirmation ? "两次输入的密码不一致" : "");
}
