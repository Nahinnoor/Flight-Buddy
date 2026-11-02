/**
 * Pull-to-refresh for a signed-in screen's scroll view.
 */
import { useState } from 'react';
import { RefreshControl } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/**
 * Returns the element for a scroll view's `refreshControl` prop. The spinner
 * shows until `reload` settles.
 */
export function useRefreshControl(reload: () => Promise<unknown>) {
  const theme = useTheme();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const onRefresh = async () => {
    setIsRefreshing(true);
    await reload();
    setIsRefreshing(false);
  };

  return (
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={() => void onRefresh()}
      tintColor={theme.textSecondary}
    />
  );
}
