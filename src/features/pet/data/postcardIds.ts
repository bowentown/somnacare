/**
 * 轻量明信片抽卡索引（~2 KB），供 travelService.ts 同步结算能量与抽卡进度使用。
 * 完整 50 张明信片的 47 KB 文案/插画路径/好友评论位于 travelPostcards.ts，
 * 仅在打开图鉴 / 到站弹窗 / 朋友圈 / 生成周报分享卡时按需懒加载，不打入首包。
 *
 * 与 travelPostcards.ts 中 TRIP_POOL 的一致性由 tests/unit/petCopy.test.ts 断言护航。
 */
export interface PostcardManifestEntry {
  id: string;
  souvenirName: string;
}

export const TRIP_POSTCARD_MANIFEST: readonly PostcardManifestEntry[] = [
  { id: 'card-asia-01', souvenirName: '粉白软糯定胜糕' },
  { id: 'card-asia-02', souvenirName: '白狐神使手绘木质绘马' },
  { id: 'card-asia-03', souvenirName: '故宫琉璃瓦拓印小青砖' },
  { id: 'card-asia-04', souvenirName: '手工莲花香蕉叶水灯' },
  { id: 'card-asia-05', souvenirName: '三色花见团子挂坠' },
  { id: 'card-asia-06', souvenirName: '洪崖洞立体镂空金属书签' },
  { id: 'card-asia-07', souvenirName: '手工腌制蜂蜜柚子茶罐' },
  { id: 'card-asia-08', souvenirName: '七彩金刚结手工编织绳' },
  { id: 'card-asia-09', souvenirName: '发光热带蕨类夜光标本' },
  { id: 'card-asia-10', souvenirName: '会安手织海蓝丝绸小灯笼' },
  { id: 'card-asia-11', souvenirName: '金黄白桦叶树脂琥珀石' },
  { id: 'card-asia-12', souvenirName: '小樽发条水晶微型八音盒' },
  { id: 'card-asia-13', souvenirName: '喜马拉雅雪松雕刻小木鱼' },
  { id: 'card-asia-14', souvenirName: '漓江青玉卵石手把件' },
  { id: 'card-asia-15', souvenirName: '粉红砂岩镂空小窗片' },
  { id: 'card-asia-16', souvenirName: '复古双层电车黄铜小纪念票' },
  { id: 'card-asia-17', souvenirName: '发光蓝海沙玻璃小星瓶' },
  { id: 'card-asia-18', souvenirName: '鸣沙山纯铜小驼铃' },
  { id: 'card-europe-19', souvenirName: '巴黎复古铜版画小明信片' },
  { id: 'card-europe-20', souvenirName: '红色电话亭合金钥匙扣' },
  { id: 'card-europe-21', souvenirName: '微型手绘荷兰小木鞋挂饰' },
  { id: 'card-europe-22', souvenirName: '威尼斯彩绘羽毛微型面具' },
  { id: 'card-europe-23', souvenirName: '千年蓝冰水晶微雕块' },
  { id: 'card-europe-24', souvenirName: '阿尔卑斯纯铜小牛铃挂饰' },
  { id: 'card-europe-25', souvenirName: '爱琴海传统蓝眼睛琉璃珠' },
  { id: 'card-europe-26', souvenirName: '极光捕梦网手工挂件' },
  { id: 'card-europe-27', souvenirName: '巴伐利亚天鹅羽毛银书签' },
  { id: 'card-europe-28', souvenirName: '高迪彩色马赛克小蜥蜴磁贴' },
  { id: 'card-europe-29', souvenirName: '多洛米蒂高山野雏菊标本' },
  { id: 'card-europe-30', souvenirName: '哈尔施塔特盐矿透明水晶盐块' },
  { id: 'card-europe-31', souvenirName: '波西米亚手磨水晶小吊坠' },
  { id: 'card-europe-32', souvenirName: '拉普兰白桦木手工雕刻小驯鹿' },
  { id: 'card-europe-33', souvenirName: '普罗旺斯初摘薰衣草干花安神香包' },
  { id: 'card-europe-34', souvenirName: '贝加尔湖封冻冰气泡琉璃挂坠' },
  { id: 'card-americas-35', souvenirName: '班夫落基山纯枫糖小枫叶糖' },
  { id: 'card-americas-36', souvenirName: '安第斯七彩羊驼毛手作编织绳' },
  { id: 'card-americas-37', souvenirName: '天空之镜晶体纯白盐花瓶' },
  { id: 'card-americas-38', souvenirName: '西雅图派克市场干向日葵花种' },
  { id: 'card-americas-39', souvenirName: '手工磨制椰子壳小风铃' },
  { id: 'card-americas-40', souvenirName: '巴塔哥尼亚花岗岩细磨小滚石' },
  { id: 'card-americas-41', souvenirName: '瓦哈卡手绘陶瓷彩花小陶铃' },
  { id: 'card-americas-42', souvenirName: '大峡谷红砂岩微缩雕刻小石盘' },
  { id: 'card-americas-43', souvenirName: '世界尽头小企鹅原木木雕' },
  { id: 'card-americas-44', souvenirName: '黄石地热彩泥拓印小陶石' },
  { id: 'card-americas-45', souvenirName: '哈瓦那粉色复古铁皮小车模' },
  { id: 'card-americas-46', souvenirName: '阿拉斯加云杉木小松果手把件' },
  { id: 'card-africa-47', souvenirName: '马赛马拉乌木手工雕刻长颈鹿' },
  { id: 'card-africa-48', souvenirName: '热气球藤编小竹篮微缩挂坠' },
  { id: 'card-africa-49', souvenirName: '纳米布亿年红砂晶莹小沙漏' },
  { id: 'card-africa-50', souvenirName: '乞力马扎罗天然坦桑石深蓝小坠' },
];
