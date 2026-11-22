export type ContinentType = 'asia' | 'europe' | 'americas' | 'africa';

export interface TravelSouvenir {
  name: string;
  emoji: string;
  rarity: 1 | 2 | 3 | 4 | 5;
  description?: string;
}

export interface TravelPostcard {
  id: string;
  index: number;
  continent: ContinentType;
  continentLabel: string;
  country: string;
  title: string;
  imageUrl: string;
  text: string;
  souvenir: TravelSouvenir;
  stampName: string;
  friendComments: {
    friend: string;
    text: string;
  }[];
}

export interface UserTravelState {
  currentEnergy: number;
  targetEnergy: number;
  totalTrips: number;
  unlockedCardIds: string[];
  souvenirInventory: string[];
  goldStars: Record<string, number>;
  countedScores: Record<string, number>;   // 已充能的日期 → 计过的分数（同晚重存取更高分）
  pendingArrival?: string | null;
}
