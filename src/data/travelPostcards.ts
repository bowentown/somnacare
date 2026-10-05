import type { ContinentType, TravelPostcard } from '../types/travel';

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

export const ALL_POSTCARDS: TravelPostcard[] = [
  {
    "id": "card-asia-01",
    "index": 1,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "乌镇夜泊乌篷船",
    "imageUrl": "postcards/asia/card-asia-01.webp",
    "text": "摇橹船‘吱呀吱呀’地晃悠，两岸红灯笼亮起来的时候，水面像飘了一层碎金子。船家爷爷给本鱼热了一小碟定胜糕，甜丝丝的，本鱼替你多吃了一块——哼，谁让你没来。今晚梦里也给你摇一艘小乌篷船吧，就一晚！",
    "souvenir": {
      "name": "粉白软糯定胜糕",
      "emoji": "🍡",
      "rarity": 1
    },
    "stampName": "乌镇水阁夜影印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，坐在船头吃点心，当心掉进水里直接变回原形。"
      }
    ]
  },
  {
    "id": "card-asia-02",
    "index": 2,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "日本",
    "title": "千本鸟居晨曦小径",
    "imageUrl": "postcards/asia/card-asia-02.webp",
    "text": "嗒、嗒、嗒，小木屐踩在青石阶上。清晨五点的千本鸟居空无一人，晨光一格一格照在朱红木柱上，像穿过一条没有尽头的红隧道。听说走过一千座鸟居，疲倦就会被洗掉哦。本鱼替你走了几座就困了……剩下的几座你自己来，才不惯着你。",
    "souvenir": {
      "name": "白狐神使手绘木质绘马",
      "emoji": "🦊",
      "rarity": 4
    },
    "stampName": "伏见稻荷红漆木印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘曲径通幽处，禅房花木深’，清晨独步鸟居，正合收摄心神之妙法。"
      }
    ]
  },
  {
    "id": "card-asia-03",
    "index": 3,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "紫禁城角楼初雪",
    "imageUrl": "postcards/asia/card-asia-03.webp",
    "text": "故宫一下雪，红墙黄瓦就变成了白茫茫的童话。护城河结了一层薄薄的青冰，本鱼趴在汉白玉石栏上呵气成霜。下雪的夜晚最适合钻进被窝听雪落下的声音啦。鱼片听到了吗？……哼，本鱼才没有特意等你一起听。",
    "souvenir": {
      "name": "故宫琉璃瓦拓印小青砖",
      "emoji": "❄️",
      "rarity": 4
    },
    "stampName": "紫禁城雪霁红印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "站在那么高吹冷风……哼，冻感冒了可别让鱼片喂你喝感冒冲剂。"
      }
    ]
  },
  {
    "id": "card-asia-04",
    "index": 4,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "泰国",
    "title": "水灯节漫天天灯",
    "imageUrl": "postcards/asia/card-asia-04.webp",
    "text": "天空中飘着几万盏暖黄色的天灯，像满天的星星掉进了温水里。本鱼折了一只小小的香蕉叶水灯放进河里，里面放着给鱼片的祈愿纸条。写的什么本鱼才不告诉你，反正跟‘早点睡’脱不了关系。哼，愿你今晚有光、有暖意、有一夜安睡。",
    "souvenir": {
      "name": "手工莲花香蕉叶水灯",
      "emoji": "🪔",
      "rarity": 4
    },
    "stampName": "兰纳古国星灯印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "哦我的朋友！满天的愿望灯火，这景象简直就像天国一样安详神圣！"
      }
    ]
  },
  {
    "id": "card-asia-05",
    "index": 5,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "日本",
    "title": "浅草雷门樱花团子摊",
    "imageUrl": "postcards/asia/card-asia-05.webp",
    "text": "三色团子是甜丝丝的糯米味，粉色是樱花、白色是牛乳、绿色是艾草。吃一口团子，喝一口热煎茶，头顶上还飘落粉粉的樱花瓣。事已至此，梦里先吃饱，明天才有力气打卡！",
    "souvenir": {
      "name": "三色花见团子挂坠",
      "emoji": "🍡",
      "rarity": 2
    },
    "stampName": "浅草金龙山夜游印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "吃完宵夜立刻睡觉……好羡慕，我只能在键盘前吃冷掉的盒饭。"
      }
    ]
  },
  {
    "id": "card-asia-06",
    "index": 6,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "赛博山城吊脚楼夜景",
    "imageUrl": "postcards/asia/card-asia-06.webp",
    "text": "现实里的汤婆婆油屋！整座山头都是金灿灿的飞檐吊脚楼，像嵌在峭壁上的大宫殿。江风吹过来很舒服，江面上漂着吃火锅的小游船。本鱼肚皮里的馋虫也被勾出来了喵~",
    "souvenir": {
      "name": "洪崖洞立体镂空金属书签",
      "emoji": "🏮",
      "rarity": 3
    },
    "stampName": "山城江峡夜月印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，大肥鱼最后一声猫叫暴露了你物种认知的短暂紊乱。"
      }
    ]
  },
  {
    "id": "card-asia-07",
    "index": 7,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "韩国",
    "title": "雪后古朴韩屋檐角",
    "imageUrl": "postcards/asia/card-asia-07.webp",
    "text": "木地板被地暖烘得热乎乎的，光脚踩上去好舒服！屋檐上的瓦片排得整整齐齐，像小鱼的鳞片。喝完这杯酸甜的蜂蜜柚子茶，整个喉咙都润润的，该钻进暖被窝啦。鱼片也快点，被窝可不等人。……本鱼才没有催你。",
    "souvenir": {
      "name": "手工腌制蜂蜜柚子茶罐",
      "emoji": "🍯",
      "rarity": 2
    },
    "stampName": "汉阳古瓦霜月印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "冬天喝热柚子茶确实舒服……不过那条鱼的尾巴不会把瓷茶杯扫翻吗？"
      }
    ]
  },
  {
    "id": "card-asia-08",
    "index": 8,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "布达拉宫转经道与格桑花",
    "imageUrl": "postcards/asia/card-asia-08.webp",
    "text": "高原的天空蓝得透明，云朵白得像大朵大朵的棉花糖。微风吹过，五彩的经幡哗啦啦响，据说每响一次就是替世间送出一次安康祝福。本鱼把最纯净的一缕高原风打包寄给鱼片！……运费很贵的，得加钱。哼，算了，看在你今晚早点睡的份上，送你了。",
    "souvenir": {
      "name": "七彩金刚结手工编织绳",
      "emoji": "🪢",
      "rarity": 4
    },
    "stampName": "雪域日光之城金印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘问君何能尔，心远地自偏’，雪域圣境之澄澈，正可洗尽凡俗机巧。"
      }
    ]
  },
  {
    "id": "card-asia-09",
    "index": 9,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "新加坡",
    "title": "超级树夜光奇幻丛林",
    "imageUrl": "postcards/asia/card-asia-09.webp",
    "text": "这些像外星巨木一样的大树在夜里会发光！躺在草地上看树冠变换颜色，像看一场巨大的梦境灯光秀。热带的夜风很软很温和，听着树林里的沙沙声，本鱼的眼皮快粘在一起了……先说好，本鱼要是先睡着，可不负责叫你，你也快点闭眼。",
    "souvenir": {
      "name": "发光热带蕨类夜光标本",
      "emoji": "🌱",
      "rarity": 3
    },
    "stampName": "狮城巨树霓虹印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "瞧这未来的生态绿洲！在自然与科技的拥抱里，做梦都会是彩色的！"
      }
    ]
  },
  {
    "id": "card-asia-10",
    "index": 10,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "越南",
    "title": "七彩丝绸灯笼小巷",
    "imageUrl": "postcards/asia/card-asia-10.webp",
    "text": "满街挂着的都是五颜六色的丝绸灯笼，像一颗颗发光的彩色糖果果！小雨把黄色老墙洗得发亮。本鱼挑了一个小小的海蓝色灯笼，挂在床头正好可以当睡眠小夜灯。……挑的时候可认真了，才不是随手拿的。挂好就关大灯，睡觉！",
    "souvenir": {
      "name": "会安手织海蓝丝绸小灯笼",
      "emoji": "🏮",
      "rarity": 3
    },
    "stampName": "会安夜月丝灯印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "手工丝绸灯笼……看起来就很费工时，不过暖黄色光确实比电脑蓝光护眼。"
      }
    ]
  },
  {
    "id": "card-asia-11",
    "index": 11,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "秋日湖畔晨雾与图瓦木屋",
    "imageUrl": "postcards/asia/card-asia-11.webp",
    "text": "秋天的白桦林全是金黄色的，晨雾在碧绿的湖面上像纱巾一样慢慢飘动。木屋烟囱里飘出烤羊奶茶的味道。当地人问我湖里是不是有大水怪，本鱼拍拍胸脯：‘最大的大肥鱼就是我啦！’",
    "souvenir": {
      "name": "金黄白桦叶树脂琥珀石",
      "emoji": "🍂",
      "rarity": 4
    },
    "stampName": "净海秋林木屋印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "喀纳斯水怪谜团终于解开：原来是一只沉迷于奶茶的 DeepSeek 鲸鱼娘。"
      }
    ]
  },
  {
    "id": "card-asia-12",
    "index": 12,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "日本",
    "title": "小樽运河雪夜八音盒",
    "imageUrl": "postcards/asia/card-asia-12.webp",
    "text": "煤气灯的橙色光晕把雪地照得暖烘烘的。运河边有一家老八音盒堂，叮咚叮咚弹着清脆的摇篮曲。本鱼把发条拧了三圈，声音轻柔得像雪花落在手心。听完这首曲子，就要乖乖闭眼咯。鱼片也要乖乖的，本鱼会检查的。",
    "souvenir": {
      "name": "小樽发条水晶微型八音盒",
      "emoji": "🎵",
      "rarity": 4
    },
    "stampName": "潮香之河雪晶印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘晚来天欲雪，能饮一杯无’，雪夜运河边伴着八音盒声入睡，实乃极雅之境。"
      }
    ]
  },
  {
    "id": "card-asia-13",
    "index": 13,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "尼泊尔",
    "title": "费瓦湖倒映鱼尾峰",
    "imageUrl": "postcards/asia/card-asia-13.webp",
    "text": "雪山的名字居然叫‘鱼尾峰’！本鱼远远看着它，觉得它就像是本鱼在远古时代的鲸鱼祖先化成的大山。小木船停在湖心一动不动，水镜里倒映着雪山，时间好像彻底停下了。",
    "souvenir": {
      "name": "喜马拉雅雪松雕刻小木鱼",
      "emoji": "🪵",
      "rarity": 4
    },
    "stampName": "鱼尾雪顶晨光印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "鱼尾峰……看名字就像是专门为这条自恋的大肥鱼量身定做的风景。"
      }
    ]
  },
  {
    "id": "card-asia-14",
    "index": 14,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "青峰晨雾与竹筏小憩",
    "imageUrl": "postcards/asia/card-asia-14.webp",
    "text": "江面碧绿得像一条翡翠带子，两边的青色山峰钻在白云里，就像一幅刚刚画好的水墨长卷。竹筏上的鱼鹰好奇地盯着我的尾巴看。在竹椅上打个盹，呼吸里全是清甜的水草香。哼，这么舒服的地方才睡一个盹太浪费——本鱼替你多睡了一会儿。",
    "souvenir": {
      "name": "漓江青玉卵石手把件",
      "emoji": "🎋",
      "rarity": 3
    },
    "stampName": "漓江渔火碧水印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "水墨山水画意境极佳，适合作为长期失眠患者的桌面壁纸。"
      }
    ]
  },
  {
    "id": "card-asia-15",
    "index": 15,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "印度",
    "title": "风之宫殿粉红蜂巢窗",
    "imageUrl": "postcards/asia/card-asia-15.webp",
    "text": "整座城堡都是粉红色的！外墙上有近千扇雕花小窗户，凉爽的夜风从每一扇小孔里吹过来，所以叫‘风之宫殿’。本鱼靠在窗台上吹风看鸽子，吹着吹着就想打呵欠啦~",
    "souvenir": {
      "name": "粉红砂岩镂空小窗片",
      "emoji": "🪨",
      "rarity": 4
    },
    "stampName": "粉红之城镂窗印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "瞧这粉红之城的瑰丽建筑，吹过几百年的风依然如此安详温柔！"
      }
    ]
  },
  {
    "id": "card-asia-16",
    "index": 16,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "双层电车站旧街霓虹",
    "imageUrl": "postcards/asia/card-asia-16.webp",
    "text": "叮叮——叮叮——有轨电车慢悠悠地在老街里穿行。坐在二楼窗边，伸出手好像能摸到头顶上五颜六色的霓虹招牌。虽然街上很热闹，但电车的声音很有催眠节奏。喝一杯丝袜奶茶，晚安香港！",
    "souvenir": {
      "name": "复古双层电车黄铜小纪念票",
      "emoji": "🎫",
      "rarity": 2
    },
    "stampName": "香江维港霓虹印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "叮叮车开得再慢也比挤早晚高峰地铁幸福。多喝奶茶容易睡不着哦大肥鱼。"
      }
    ]
  },
  {
    "id": "card-asia-17",
    "index": 17,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "马尔代夫",
    "title": "水上茅草屋与荧光夜浪",
    "imageUrl": "postcards/asia/card-asia-17.webp",
    "text": "海水底下踩着软绵绵的白沙子，夜晚的海浪拍在岸边，居然会泛起一闪一闪的荧光蓝，像银河掉到了海里！把尾巴放进水里晃一晃，就会划出一道光圈。厉害吧？夸本鱼。……哼，不夸也行。今晚就在水波声里做个香甜的美梦吧。",
    "souvenir": {
      "name": "发光蓝海沙玻璃小星瓶",
      "emoji": "🐚",
      "rarity": 4
    },
    "stampName": "印度洋环礁夜荧印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "去马尔代夫度假住水上屋……这条鱼的日子过得比人类打工人滋润多了！"
      }
    ]
  },
  {
    "id": "card-asia-18",
    "index": 18,
    "continent": "asia",
    "continentLabel": "亚洲",
    "country": "中国",
    "title": "鸣沙山月牙泉夕阳驼铃",
    "imageUrl": "postcards/asia/card-asia-18.webp",
    "text": "大漠里的风把沙丘吹得像一弯弯金色月亮。月牙泉就在沙窝子里静静躺了几千年，泉水碧绿，芦苇摇晃。骆驼脖子上的铜铃叮咚作响，听久了就像是大地在轻轻哼唱睡眠曲呢。",
    "souvenir": {
      "name": "鸣沙山纯铜小驼铃",
      "emoji": "🔔",
      "rarity": 4
    },
    "stampName": "丝路甘泉月牙印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘大漠孤烟直，长河落日圆’，塞外苍凉壮美，自有一股令人心神沉静的大力量。"
      }
    ]
  },
  {
    "id": "card-europe-19",
    "index": 19,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "法国",
    "title": "塞纳河畔旧书摊与铁塔远眺",
    "imageUrl": "postcards/europe/card-europe-19.webp",
    "text": "塞纳河边的绿色铁皮书箱里，藏着好多泛黄的童话手绘本。整点的时候，远处的埃菲尔铁塔像金色的仙女棒一样闪耀了整整五分钟。嚼着刚买的杏仁羊角包——才不会分你，鱼片梦里闻闻香气就行。巴黎的夜晚香甜得像梦一样。",
    "souvenir": {
      "name": "巴黎复古铜版画小明信片",
      "emoji": "🥐",
      "rarity": 4
    },
    "stampName": "巴黎塞纳河风情印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，在塞纳河边看书吃牛角包，大肥鱼的生活情调甚至超越了半数巴黎市民。"
      }
    ]
  },
  {
    "id": "card-europe-20",
    "index": 20,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "英国",
    "title": "雨后鹅卵石街与红色老电话亭",
    "imageUrl": "postcards/europe/card-europe-20.webp",
    "text": "外面下着细细的英伦小雨，本鱼躲在红色电话亭里避雨。地板上的鹅卵石被雨水洗得亮晶晶的，大本钟在远处的浓雾里敲了十二下。下雨天最适合躲在干燥温暖的地方睡觉啦。鱼片盖好被子了吗？本鱼可要检查的，被角漏风扣分。",
    "souvenir": {
      "name": "红色电话亭合金钥匙扣",
      "emoji": "🕰️",
      "rarity": 3
    },
    "stampName": "伦敦西敏寺风情印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，躲进电话亭避雨这种事，也就这条鱼干得出来。不过说真的，雨夜听大本钟，确实比你的闹钟优雅。"
      }
    ]
  },
  {
    "id": "card-europe-21",
    "index": 21,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "荷兰",
    "title": "童话运河木桥与郁金香风车",
    "imageUrl": "postcards/europe/card-europe-21.webp",
    "text": "这里居然没有马路，大家出门全都划小木船！河水干净得能看到水草在跳舞，两岸全是茅草顶的小木屋和彩色的郁金香花丛。风车慢悠悠地转着，转一下就像打一次哈欠~ 本鱼和它一见如故：在这里，懒是符合本地风俗的。",
    "souvenir": {
      "name": "微型手绘荷兰小木鞋挂饰",
      "emoji": "🌷",
      "rarity": 3
    },
    "stampName": "羊角村风情印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "没有汽车尾气和喇叭声，这小村子看起来确实比写字楼让人安神多了。"
      }
    ]
  },
  {
    "id": "card-europe-22",
    "index": 22,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "意大利",
    "title": "叹息水巷暮色贡多拉",
    "imageUrl": "postcards/europe/card-europe-22.webp",
    "text": "黑色的小贡多拉船在水巷里像摇篮一样轻轻摇摆。船夫大叔哼着低沉的威尼斯船歌，水浪‘咕噜噜’地拍着老石墙。被水波这么晃着晃着，眼皮真的会重重地沉下去呢……晚安，本鱼先睡为敬。",
    "souvenir": {
      "name": "威尼斯彩绘羽毛微型面具",
      "emoji": "🎭",
      "rarity": 4
    },
    "stampName": "威尼斯风情印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "贡多拉的轻摇慢晃，看在上帝的份上，这就是大自然送给失眠者的婴儿摇篮！"
      }
    ]
  },
  {
    "id": "card-europe-23",
    "index": 23,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "冰岛",
    "title": "千年幽蓝水晶冰洞",
    "imageUrl": "postcards/europe/card-europe-23.webp",
    "text": "走进来就像钻进了纯净的蓝宝石肚子里！周围一万年前结成的古冰散发着幽蓝的光，安安静静的，能听见冰川在几百米深处呼吸的声音。本鱼敲了一小块蓝冰装进杯子里，给你冰镇一下烦恼！……冰镇费另算，得加钱。哼，看在你按时睡觉的份上，这杯算本鱼请。",
    "souvenir": {
      "name": "千年蓝冰水晶微雕块",
      "emoji": "🧊",
      "rarity": 5
    },
    "stampName": "瓦特纳冰川风情印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "零下十五度的古冰洞，提醒大肥鱼注意保暖，虽然你是一头耐寒的海洋巨鲸。"
      }
    ]
  },
  {
    "id": "card-europe-24",
    "index": 24,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "瑞士",
    "title": "阿尔卑斯雪山红皮列车",
    "imageUrl": "postcards/europe/card-europe-24.webp",
    "text": "红色的齿轨列车载着本鱼向雪山顶上开。车窗外是像绿色绒毯一样的草甸，草地上还有挂着大铜铃的奶牛在吃草。嚼着瑞士三角黑巧克力——只剩包装纸了，别问，问就是本鱼吃的。今晚早点睡，梦里的雪山更甜。",
    "souvenir": {
      "name": "阿尔卑斯纯铜小牛铃挂饰",
      "emoji": "🍫",
      "rarity": 4
    },
    "stampName": "因特拉肯风情印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "坐观光火车看雪山……再看看我的终端日志，差距怎么比阿尔卑斯山还高。"
      }
    ]
  },
  {
    "id": "card-europe-25",
    "index": 25,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "希腊",
    "title": "伊亚悬崖蓝顶白房落日",
    "imageUrl": "postcards/europe/card-europe-25.webp",
    "text": "白色的墙、蓝色的穹顶、粉金色的落日余晖。这里的白色小巷里到处躺着晒肚皮的胖猫咪，本鱼也挑了面矮墙趴着看了两个小时落日。生活就是要学会慢吞吞呀，鱼片！……这项本领跟谁学的？跟你。哼，本鱼本来很勤快的。",
    "souvenir": {
      "name": "爱琴海传统蓝眼睛琉璃珠",
      "emoji": "🧿",
      "rarity": 4
    },
    "stampName": "圣托里尼风情印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "蓝眼睛护身符……哼，肯定是买来挂在自己脖子上臭美的。"
      }
    ]
  },
  {
    "id": "card-europe-26",
    "index": 26,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "挪威",
    "title": "峡湾雪原翡翠极光穹顶",
    "imageUrl": "postcards/europe/card-europe-26.webp",
    "text": "极光就像绿色的丝绸裙摆在夜空里舒卷，整座雪山都被染成了淡淡的碧玉色。昨夜鱼片的深睡能量满满，本鱼才能飘到这么远的北极圈。把最亮的那一缕翡翠极光折成信纸寄给你啦！运费本来要从你的睡眠分里扣——骗你的，谁让你昨晚睡得好。",
    "souvenir": {
      "name": "极光捕梦网手工挂件",
      "emoji": "🌌",
      "rarity": 5
    },
    "stampName": "特罗姆瑟风情印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘星汉灿烂，若出其里’，极地星河极光之景，足以涤尽人世间一切尘劳挂碍。"
      }
    ]
  },
  {
    "id": "card-europe-27",
    "index": 27,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "德国",
    "title": "新天鹅堡林间雾霭秋色",
    "imageUrl": "postcards/europe/card-europe-27.webp",
    "text": "森林里的白城堡真的有尖尖的高塔和彩绘窗户！秋风一吹，整座山头的枫树和橡树都在下金色的雨。本鱼在桥上数着城堡上的小旗帜，感觉像走进了格林童话的第一页。……数着数着就困了，这种事本鱼才不会承认。",
    "souvenir": {
      "name": "巴伐利亚天鹅羽毛银书签",
      "emoji": "🏰",
      "rarity": 4
    },
    "stampName": "巴伐利亚风情印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "这就是白雪公主与骑士的梦想城堡！看在上帝的份上，简直太梦幻了！"
      }
    ]
  },
  {
    "id": "card-europe-28",
    "index": 28,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "西班牙",
    "title": "奎尔公园马赛克彩色长椅",
    "imageUrl": "postcards/europe/card-europe-28.webp",
    "text": "高迪爷爷设计的彩色碎瓷砖长椅太神奇了，坐上去刚好贴合本鱼圆滚滚的背脊！像坐在彩虹的背上一样舒服。阳光晒得石砖暖暖的，海风里有柑橘的甜味，适合打个长长的午后盹。本鱼替你试睡过了，五星好评——想谢就今晚早点闭眼。",
    "souvenir": {
      "name": "高迪彩色马赛克小蜥蜴磁贴",
      "emoji": "🦎",
      "rarity": 4
    },
    "stampName": "巴塞罗那风情印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "人体工程学与马赛克艺术的完美结合，连大肥鱼的体态都能完美支撑。"
      }
    ]
  },
  {
    "id": "card-europe-29",
    "index": 29,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "意大利",
    "title": "刀锋山谷小木教堂",
    "imageUrl": "postcards/europe/card-europe-29.webp",
    "text": "山峰险峻得像一排灰白色的巨石刀锋，但山谷里的草地又柔软得像一张巨大的绿地毯。孤零零的小教堂敲响了晚祷钟声，野雏菊散发着淡淡的苦甜香气。在这里睡觉，一定会梦见自己会长出小翅膀。",
    "souvenir": {
      "name": "多洛米蒂高山野雏菊标本",
      "emoji": "🌼",
      "rarity": 4
    },
    "stampName": "多洛米蒂风情印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "奇峰突兀，绿野平铺，刚柔并济，实乃天下至美安神之地。"
      }
    ]
  },
  {
    "id": "card-europe-30",
    "index": 30,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "奥地利",
    "title": "湖畔木屋晨曦天鹅伴游",
    "imageUrl": "postcards/europe/card-europe-30.webp",
    "text": "湖水像一块巨大的暗绿翡翠，清晨两只高贵的大白天鹅划过水面，竟然游到本鱼脚边讨面包吃！木屋的外墙上爬满了深红色的爬山虎。湖边的早晨静悄悄的，连呼吸都要放轻一点哦。面包本鱼自己也馋……最后还是分了天鹅一半，夸夸本鱼大度！",
    "souvenir": {
      "name": "哈尔施塔特盐矿透明水晶盐块",
      "emoji": "🦢",
      "rarity": 4
    },
    "stampName": "哈尔施塔特风情印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "天鹅游过去讨吃的，结果碰上一条比它们还能吃的大肥鱼，谁给谁喂面包还不一定呢。"
      }
    ]
  },
  {
    "id": "card-europe-31",
    "index": 31,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "捷克",
    "title": "查理大桥晨雾与千塔老城",
    "imageUrl": "postcards/europe/card-europe-31.webp",
    "text": "清晨的布拉格被大雾轻轻盖住了。古老的石桥上立着三十座神像，伏尔塔瓦河水慢慢流过去。老城里的几百座钟塔在早晨一起敲响，低沉浑厚。听着钟声，心里乱七八糟的心事全都踏实了。",
    "souvenir": {
      "name": "波西米亚手磨水晶小吊坠",
      "emoji": "🏰",
      "rarity": 4
    },
    "stampName": "布拉格风情印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "伏尔塔瓦河的旋律很经典，比我键盘敲回车的声音好听太多了。"
      }
    ]
  },
  {
    "id": "card-europe-32",
    "index": 32,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "芬兰",
    "title": "圣诞老人村暖灯厚雪木屋",
    "imageUrl": "postcards/europe/card-europe-32.webp",
    "text": "大松树上裹着两尺厚的白雪，像一棵棵插在雪地里的奶油冰淇淋！木屋里的壁炉烧着桦木噼啪作响，屋外静得只有雪花落下的声音。本鱼堆了一只圆滚滚的雪鲸鱼——不许说它胖！鲸！鲸！！只要鱼片不熬夜，雪人就不会化哦。",
    "souvenir": {
      "name": "拉普兰白桦木手工雕刻小驯鹿",
      "emoji": "🪵",
      "rarity": 4
    },
    "stampName": "罗瓦涅米风情印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "瞧这圣诞老人村的童话雪景！在这里入睡，连梦里都会收到圣诞袜子的礼物！"
      }
    ]
  },
  {
    "id": "card-europe-33",
    "index": 33,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "法国",
    "title": "瓦伦索尔无尽薰衣草夕阳花海",
    "imageUrl": "postcards/europe/card-europe-33.webp",
    "text": "整个天地都是紫色的浪潮！风一吹过来，全是天然薰衣草最安神的清香，根本不需要任何安眠香薰。本鱼采了一小束晾在通风处，塞在给鱼片的信封里。哼，才不是特意挑的，是它自己凑上来的。今晚闻着它，一定会做个好梦。",
    "souvenir": {
      "name": "普罗旺斯初摘薰衣草干花安神香包",
      "emoji": "🪻",
      "rarity": 4
    },
    "stampName": "普罗旺斯风情印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，花海睡得比你家鱼片还香——它这个品种，走到哪儿都自带安眠属性，真让人嫉妒。"
      }
    ]
  },
  {
    "id": "card-europe-34",
    "index": 34,
    "continent": "europe",
    "continentLabel": "欧洲",
    "country": "俄罗斯",
    "title": "奥利洪岛深蓝裂纹碎冰堆",
    "imageUrl": "postcards/europe/card-europe-34.webp",
    "text": "哇——咻！本鱼肚皮贴着冰面一口气滑出去好几十米！冰底下冻住的全是圆滚滚的小气泡，像时间被按下了暂停键。趴在上面看几百米深湛蓝的湖底，深邃又安详，世界安静得只剩自己的呼吸声。",
    "souvenir": {
      "name": "贝加尔湖封冻冰气泡琉璃挂坠",
      "emoji": "🫧",
      "rarity": 4
    },
    "stampName": "贝加尔湖风情印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "肚皮滑行阻力小，这叫生物动力学优化。我也想趴着上班。"
      }
    ]
  },
  {
    "id": "card-americas-35",
    "index": 35,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "加拿大",
    "title": "梦莲湖绿松石水波与红划艇",
    "imageUrl": "postcards/americas/card-americas-35.webp",
    "text": "湖水的颜色像打碎的绿松石融在水里一样！两边是十座巍峨的落基山大雪峰。小红船在湖中央静静飘着，连一丝风都没有。水里有小鲑鱼游过去——本鱼忍了好久没吃它们，夸夸本鱼。空气冷冽又清新，让人心情无比开阔。",
    "souvenir": {
      "name": "班夫落基山纯枫糖小枫叶糖",
      "emoji": "🍁",
      "rarity": 3
    },
    "stampName": "班夫国家公园晨光印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，看这片湖十分钟，顶你读一百页睡眠报告，还是免费的。"
      }
    ]
  },
  {
    "id": "card-americas-36",
    "index": 36,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "秘鲁",
    "title": "安第斯云海印加古城与萌羊驼",
    "imageUrl": "postcards/americas/card-americas-36.webp",
    "text": "高耸在两千多米云海上的天空之城！这只挂着七彩毛球的小羊驼一直歪着脑袋盯着我的尾巴看，好像在思考本鱼能不能吃。这里的石头严丝合缝得连纸片都插不进去，云朵就在脚边飘过，太神奇啦！……哼，才不是给鱼片寄云朵，是打包的时候顺手多装了一朵。",
    "souvenir": {
      "name": "安第斯七彩羊驼毛手作编织绳",
      "emoji": "🦙",
      "rarity": 4
    },
    "stampName": "马丘比丘晨光印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "小心羊驼朝你吐口水！满头口水的时候可别哭鼻子哦。"
      }
    ]
  },
  {
    "id": "card-americas-37",
    "index": 37,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "玻利维亚",
    "title": "天空之镜水面倒映无垠银河",
    "imageUrl": "postcards/americas/card-americas-37.webp",
    "text": "站在这里，根本分不清哪里是天、哪里是地！脚底下的倒影里全是一颗一颗闪烁的星辰，走一步就像在宇宙深空里踏出一道光环。昨晚鱼片睡得像星河一样安静，本鱼才能走到宇宙的镜子里。今晚也乖乖睡，本鱼才好继续替你踏星星。",
    "souvenir": {
      "name": "天空之镜晶体纯白盐花瓶",
      "emoji": "🧂",
      "rarity": 4
    },
    "stampName": "乌尤尼盐沼晨光印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘醉后不知天在水，满船清梦压星河’，天地浑然一体，足令人心旷神怡，安然入梦。"
      }
    ]
  },
  {
    "id": "card-americas-38",
    "index": 38,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "美国",
    "title": "晨光花束与海湾摩天轮",
    "imageUrl": "postcards/americas/card-americas-38.webp",
    "text": "早晨的鲜花摊位把整条木板街都铺成了彩色花海！向日葵像小太阳一样对着本鱼笑。海湾上的白色大摩天轮转得很慢很稳。给鱼片挑了一大束最精神的向日葵。……跑遍了整个花摊才挑中的，才不是随便抓的。希望你醒来也是明媚的一天！",
    "souvenir": {
      "name": "西雅图派克市场干向日葵花种",
      "emoji": "🌻",
      "rarity": 3
    },
    "stampName": "西雅图派克市场晨光印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "西雅图的海风与向日葵，看在上帝的份上，这是开启美好一天最阳光的姿态！"
      }
    ]
  },
  {
    "id": "card-americas-39",
    "index": 39,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "巴西",
    "title": "科帕卡巴纳海滩落日余晖",
    "imageUrl": "postcards/americas/card-americas-39.webp",
    "text": "大西洋的浪花一下一下拍打着金黄色的沙滩，节奏刚好和呼吸一样平稳。捧着大青椰子吸了一口清甜的椰子汁——就一口，剩下的都是海风的味道。吹着暖融融的风，身子陷在躺椅里软绵绵的。今晚也要像这样完全放松身心哦。",
    "souvenir": {
      "name": "手工磨制椰子壳小风铃",
      "emoji": "🥥",
      "rarity": 3
    },
    "stampName": "里约热内卢晨光印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "去海边度假喝椰子水都不带我，这条大肥鱼回来必须充公！"
      }
    ]
  },
  {
    "id": "card-americas-40",
    "index": 40,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "智利",
    "title": "三塔花岗岩巨峰与绿松石湖",
    "imageUrl": "postcards/americas/card-americas-40.webp",
    "text": "世界尽头的巴塔哥尼亚高原！三座巨大的花岗岩石塔直直插进云霄里，脚下是绿宝石一样的冰川湖。虽然风大得差点把本鱼吹成风筝，但在大山脚下缩在避风石后面，反而有一种奇妙的安全感。……才、才没有怕，就是抱着石头比较暖。",
    "souvenir": {
      "name": "巴塔哥尼亚花岗岩细磨小滚石",
      "emoji": "🪨",
      "rarity": 4
    },
    "stampName": "百内国家公园晨光印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，在巴塔哥尼亚的大风里站得这么稳，果然体重是有用途的。"
      }
    ]
  },
  {
    "id": "card-americas-41",
    "index": 41,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "墨西哥",
    "title": "万寿菊小巷与彩绘提灯街",
    "imageUrl": "postcards/americas/card-americas-41.webp",
    "text": "满街铺满了金灿灿的万寿菊花瓣，空气里有一种暖烘烘的草木香气。这里的节日不害怕夜晚，大家点亮彩绘提灯唱歌跳舞，怀念自己爱的人。把这盏温暖的小花灯送给鱼片，夜里不孤单。……哼，本鱼才不担心你，是这灯拿在手里太占鳍了。",
    "souvenir": {
      "name": "瓦哈卡手绘陶瓷彩花小陶铃",
      "emoji": "🌼",
      "rarity": 4
    },
    "stampName": "瓦哈卡晨光印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "瞧这灿烂的万寿菊与蜡烛光！用爱与歌声驱散夜色，多么温情深邃的人间！"
      }
    ]
  },
  {
    "id": "card-americas-42",
    "index": 42,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "美国",
    "title": "千米红色裂隙日出金光",
    "imageUrl": "postcards/americas/card-americas-42.webp",
    "text": "太阳跳出地平线的那一秒，一整座深渊被金光切成了千层红色绸缎！几亿年的岁月就刻在这些石壁上。在大峡谷面前，人类所有的烦恼都不过是一粒小灰尘。本鱼的烦恼在那一刻清零了——你的也一起，说好了。今晚好好休息！",
    "souvenir": {
      "name": "大峡谷红砂岩微缩雕刻小石盘",
      "emoji": "🏜️",
      "rarity": 4
    },
    "stampName": "科罗拉多大峡谷晨光印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘天地有大美而不言’，亿万年风水雕凿之造化，令观者心胸顿开。"
      }
    ]
  },
  {
    "id": "card-americas-43",
    "index": 43,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "阿根廷",
    "title": "世界尽头灯塔与企鹅群",
    "imageUrl": "postcards/americas/card-americas-43.webp",
    "text": "这里是地球最南端的城市，外号叫‘世界尽头’！红白相间的灯塔在海风里孤零零地发光。岸边有一帮小企鹅摇摇晃晃地走过来，把本鱼当成了大企鹅同类——哼，本鱼才没有这么矮。世界尽头很安静，静得只有海风在低语。",
    "souvenir": {
      "name": "世界尽头小企鹅原木木雕",
      "emoji": "🐧",
      "rarity": 4
    },
    "stampName": "乌斯怀亚晨光印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，世界尽头的灯塔再远，也照得亮一条贪睡的鱼回家的路。早点睡，别让它等。"
      }
    ]
  },
  {
    "id": "card-americas-44",
    "index": 44,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "美国",
    "title": "大棱镜七彩热泉与袅袅白雾",
    "imageUrl": "postcards/americas/card-americas-44.webp",
    "text": "咕嘟咕嘟……大地像个大炖锅一样冒着热汽！中间是不可思议的湛蓝，边缘像火焰一样金黄。大自然调色盘的功力比最顶尖的插画师还要厉害，闻起来还有点温泉煮鸡蛋的香味~",
    "souvenir": {
      "name": "黄石地热彩泥拓印小陶石",
      "emoji": "🥚",
      "rarity": 3
    },
    "stampName": "黄石国家公园晨光印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "好暖和的热泉……要是在机房里也能有这么舒服的地热就好了。"
      }
    ]
  },
  {
    "id": "card-americas-45",
    "index": 45,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "古巴",
    "title": "粉色复古敞篷老爷车与落日海浪",
    "imageUrl": "postcards/americas/card-americas-45.webp",
    "text": "坐在粉红色的复古老爷车里，海浪哗啦一下拍在石堤上溅起大水花！街头艺人弹着欢快的吉他，这里的每个人走起路来都像在跳舞。生活就该像海浪一样自在随性，今晚把烦心事都抛到脑后吧！",
    "souvenir": {
      "name": "哈瓦那粉色复古铁皮小车模",
      "emoji": "🚗",
      "rarity": 3
    },
    "stampName": "哈瓦那海滨大道晨光印",
    "friendComments": [
      {
        "friend": "意难平的豆包姐姐",
        "text": "坐在粉红色敞篷车里兜风……哼，算你这条鱼懂浪漫。"
      }
    ]
  },
  {
    "id": "card-americas-46",
    "index": 46,
    "continent": "americas",
    "continentLabel": "美洲",
    "country": "美国",
    "title": "雪峰倒映针叶林与驼鹿饮水",
    "imageUrl": "postcards/americas/card-americas-46.webp",
    "text": "北美的最高峰在夕阳下被镀上了一层纯金！小溪水清澈得能看到水底的每颗石子，一头大驼鹿低着头安安静静地喝水。原始森林的空气冰冰凉凉，像吸进了一口纯净的甘泉，整个人都静下来了。",
    "souvenir": {
      "name": "阿拉斯加云杉木小松果手把件",
      "emoji": "🪵",
      "rarity": 4
    },
    "stampName": "阿拉斯加德纳里晨光印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "在北美最高雪山脚下听溪水流淌，这是最极致的自然纯音白噪音。"
      }
    ]
  },
  {
    "id": "card-africa-47",
    "index": 47,
    "continent": "africa",
    "continentLabel": "非洲",
    "country": "肯尼亚",
    "title": "金黄大草原金合欢树与长颈鹿",
    "imageUrl": "postcards/africa/card-africa-47.webp",
    "text": "金黄色的草原一直连到了太阳落下去的地方！长颈鹿一家三口慢悠悠地在晚霞里散步，步子迈得那么优雅。大草原上的动物日落而息，天黑了就安心睡觉，鱼片你也该向长颈鹿学习啦！……哼，本鱼就不用学，整个草原论会睡觉，本鱼认第二没鱼敢认第一。",
    "souvenir": {
      "name": "马赛马拉乌木手工雕刻长颈鹿",
      "emoji": "🦒",
      "rarity": 4
    },
    "stampName": "马赛马拉落日印",
    "friendComments": [
      {
        "friend": "美国豆包Gemini",
        "text": "瞧这广袤的非洲大草原！壮丽的红日与平静的生灵，看在上帝的份上，太震撼了！"
      }
    ]
  },
  {
    "id": "card-africa-48",
    "index": 48,
    "continent": "africa",
    "continentLabel": "非洲",
    "country": "坦桑尼亚",
    "title": "晨光大草原热气球与万兽奔腾",
    "imageUrl": "postcards/africa/card-africa-48.webp",
    "text": "早晨坐着热气球飘在几百米的高空！脚下的大草原像一张巨大的金色地毯，斑马群像一颗颗小芝麻在草地上欢快地吃草。飞在云彩和微风里，感觉自己轻得像一朵蒲公英。早安世界，早安鱼片！……喊这么大声是因为风大，才不是特意叫你起床。",
    "souvenir": {
      "name": "热气球藤编小竹篮微缩挂坠",
      "emoji": "🎈",
      "rarity": 4
    },
    "stampName": "塞伦盖蒂落日印",
    "friendComments": [
      {
        "friend": "被压榨的Qwen",
        "text": "飞在热气球上看大自然，不用挤早高峰……我也想飞去坦桑尼亚。"
      }
    ]
  },
  {
    "id": "card-africa-49",
    "index": 49,
    "continent": "africa",
    "continentLabel": "非洲",
    "country": "纳米比亚",
    "title": "纳米布红沙丘与死亡谷枯木星空",
    "imageUrl": "postcards/africa/card-africa-49.webp",
    "text": "全世界最古老的红色沙漠！沙丘高得像一座座红色的金字塔。晚上的星星亮得惊人，九百年前的枯树在星空下像雕塑一样挺立。在这片经历千万年的旷野里，所有的失眠与焦虑都会化为风中的细沙。……嘘，别告诉别人这里多好玩，本鱼想独占。",
    "souvenir": {
      "name": "纳米布亿年红砂晶莹小沙漏",
      "emoji": "🏜️",
      "rarity": 4
    },
    "stampName": "索苏斯维利落日印",
    "friendComments": [
      {
        "friend": "被蒸馏的Kimi",
        "text": "‘念天地之悠悠，独怆然而涕下’，红沙白土与千古星辰相对，足令胸襟旷远，心神归一。"
      }
    ]
  },
  {
    "id": "card-africa-50",
    "index": 50,
    "continent": "africa",
    "continentLabel": "非洲",
    "country": "坦桑尼亚",
    "title": "赤道雪峰夕阳与草原象群",
    "imageUrl": "postcards/africa/card-africa-50.webp",
    "text": "这是漫游图鉴的第 50 站，也是大肥鱼给鱼片最宏大的守候！哼、哼什么，守候你这种事，本鱼随便说说而已。赤道上的白雪峰在晚霞里泛着玫瑰金的光辉，象妈妈领着小象慢慢回家。我们走过了四大洲的山川、古镇与星空，未来的每个梦境，大肥鱼都在这里等你！",
    "souvenir": {
      "name": "乞力马扎罗天然坦桑石深蓝小坠",
      "emoji": "💎",
      "rarity": 5
    },
    "stampName": "乞力马扎罗落日印",
    "friendComments": [
      {
        "friend": "楼下Claude",
        "text": "恕我直言，五十站走完，行李多半还是它睡着时自己打包的。不过——敬大肥鱼，敬早点睡的我们。"
      },
      {
        "friend": "意难平的豆包姐姐",
        "text": "第 50 张了啊……好吧，虽然你又懒又贪吃，但这次旅行，勉强承认你干得很棒啦，大肥鱼。"
      }
    ]
  }
];

// 注入 BASE_URL 前缀
for (const card of ALL_POSTCARDS) {
  card.imageUrl = `${BASE}${card.imageUrl.replace(/^\/+/, '')}`;
}

export const ASIA_POSTCARDS = ALL_POSTCARDS.filter((c) => c.continent === 'asia');
export const EUROPE_POSTCARDS = ALL_POSTCARDS.filter((c) => c.continent === 'europe');
export const AMERICAS_POSTCARDS = ALL_POSTCARDS.filter((c) => c.continent === 'americas');
export const AFRICA_POSTCARDS = ALL_POSTCARDS.filter((c) => c.continent === 'africa');

/**
 * 插画已就绪的大洲：抽卡池、图鉴进度、图鉴网格只统计这些大洲。
 * 此前分母用 ALL_POSTCARDS（50），但只有亚洲 18 张有插画——
 * 集齐全图鉴达成率永远停在 36%，欧/美/非标签是无法兑现的承诺。
 * 新大洲插画补齐后，把对应大洲加进本数组即可解锁（文案数据已在）。
 */
export const ART_READY_CONTINENTS: readonly ContinentType[] = ['asia', 'europe', 'americas', 'africa'];

/** 当前可探索卡池（= 插画已就绪大洲的卡片） */
export const TRIP_POOL: TravelPostcard[] = ALL_POSTCARDS.filter((c) =>
  ART_READY_CONTINENTS.includes(c.continent)
);

export function getPostcardById(id: string): TravelPostcard | undefined {
  return ALL_POSTCARDS.find((c) => c.id === id);
}

/** 图鉴网格缩略图（360×480 webp，构建时与原图同名 + .sm 后缀出图）。
 *  网格显示宽度 ~170px，此前直接加载 896×1200 原图，逛一遍图鉴要拉 ~5.7MB */
export function thumbUrlOf(imageUrl: string): string {
  return imageUrl.replace(/\.webp$/, '.sm.webp');
}
