export type ParameterType = 'INT' | 'DOUBLE' | 'BOOLEAN' | 'ENUM';

export interface StrategyParameterSchema {
  key: string;
  displayName: string;
  type: ParameterType;
  defaultValue: string;
  isRequired: boolean;
  minValue?: number;
  maxValue?: number;
  options?: string[];
}
