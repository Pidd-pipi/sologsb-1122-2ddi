/** 开挖方法 */
export type ExcavationMethod = '全断面' | '台阶法' | 'CD 法';

export const EXCAVATION_METHODS: ExcavationMethod[] = ['全断面', '台阶法', 'CD 法'];

/** 风化程度 */
export type Weathering = '未风化' | '微风化' | '弱风化' | '强风化' | '全风化';

export const WEATHERINGS: Weathering[] = ['未风化', '微风化', '弱风化', '强风化', '全风化'];

export const LITHOLOGIES = ['石灰岩', '砂岩', '泥岩', '页岩', '花岗岩', '片麻岩', '板岩', '断层角砾岩'];

/** 岩层产状 */
export interface Attitude {
  /** 走向 ° */
  strike: number;
  /** 倾向 ° */
  dipDirection: number;
  /** 倾角 ° */
  dipAngle: number;
}

/** 隧道掌子面编录档案 */
export interface TunnelFace {
  id: string;
  /** 掌子面编号 */
  faceNo: string;
  /** 里程桩号（米） */
  chainage: number;
  /** 编录里程区间（米） */
  mileageRange: [number, number];
  excavationMethod: ExcavationMethod;
  /** 开挖断面尺寸 m，宽×高 */
  faceSize: string;
  lithology: string;
  weathering: Weathering;
  /** 饱和抗压强度 MPa */
  rockStrength: number;
  attitude: Attitude;
  recordedAt: number;
  geologist: string;
  /** 最近一次修改时间（离线合并冲突判定用） */
  updatedAt?: number;
  /** 最近一次修改设备 id */
  updatedBy?: string;
  /** face-diverge 冲突中两版都留时，归档进来的对端版本 */
  remoteSnapshot?: TunnelFace;
  /** 归档版本的来源批次/设备说明 */
  remoteSource?: string;
}

export type TunnelFaceDraft = Omit<TunnelFace, 'id' | 'recordedAt'>;
