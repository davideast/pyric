/** Firebase-compatible public value types for `pyric/app`. */
export interface FirebaseOptions {
  apiKey?: string;
  authDomain?: string;
  databaseURL?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}

export interface FirebaseAppSettings {
  name?: string;
  automaticDataCollectionEnabled?: boolean;
}

export interface FirebaseApp {
  readonly name: string;
  readonly options: FirebaseOptions;
  automaticDataCollectionEnabled: boolean;
}
