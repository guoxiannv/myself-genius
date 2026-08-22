import { registerRootComponent } from 'expo';

import App from './App';
import { withBuildIdentity } from './build-identity';

registerRootComponent(withBuildIdentity(App));
